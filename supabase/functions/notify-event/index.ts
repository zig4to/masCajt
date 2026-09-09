// Sends a push notification when someone creates a new dogodek.
//
// Called by the notify_new_event trigger on kv_store (see
// supabase-schema.sql), which posts through pg_net. The dashboard's Database
// Webhooks UI would have been the obvious route, but this project never had
// webhooks enabled and so has no supabase_functions schema for them to hang
// off. Going straight to pg_net turned out better anyway: the trigger filters
// on the key, so availability saves, comments and photos never reach this
// function at all, where a webhook would have invoked it for every insert.
//
// The key is re-checked here regardless. The trigger is not the only thing
// that can reach a public function URL.
//
// Deploy: Supabase dashboard -> Edge Functions -> notify-event -> Edit. Select
// everything already in the editor and delete it first, THEN paste this whole
// file. Pasting below the existing contents leaves two copies in one file and
// the worker dies on boot with "Identifier 'webpush' has already been
// declared" and every call 503s -- which is exactly how this function sat
// silently dead, sending nothing to anyone. After deploying, set the three
// secrets listed below.
//
// An editor here will flag "Cannot find name 'Deno'" and the npm: imports.
// That is expected and not worth fixing: this file never runs against the
// repo's toolchain, only inside Supabase's Deno runtime, where both resolve.
// A clean deploy is the check that matters.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
// The service_role key bypasses RLS, which is how this reads subscription rows
// that the browser deliberately cannot enumerate.
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Configured once, but guarded: setVapidDetails throws on a missing or
// malformed key, and at module scope that throw is a boot failure -- the
// whole function then 503s on every call with nothing in the logs pointing
// at the keys. Caught here instead, so a bad secret becomes a plain logged
// line from the handler below and the rest of the function still loads.
let vapidError = "";
try {
  const pub = Deno.env.get("VAPID_PUBLIC_KEY");
  const priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) {
    vapidError =
      "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set in the function secrets";
  } else {
    webpush.setVapidDetails(
      Deno.env.get("VAPID_SUBJECT") ?? "mailto:tina.brdnik@gmail.com",
      pub,
      priv
    );
  }
} catch (e) {
  vapidError = `setVapidDetails rejected the keys: ${String(e)}`;
}

// Mirrors skupni-koledar.jsx. A day's events, comments and photos all live
// under the "avail:" prefix with a reserved person segment; only one of them
// should notify anyone.
const EVENT_MARKER = "__event__";

// A push service holds a message this long for a device it cannot reach.
// Sixty seconds -- the default -- would mean a phone in a pocket misses the
// notification entirely rather than getting it when it wakes.
const TTL_SECONDS = 86400;

type Subscription = {
  name?: string;
  subscription?: { endpoint: string; keys?: { p256dh: string; auth: string } };
};

// Always 200. A webhook that sees a failure retries, and a retry here would
// mean sending the notification twice -- worse than dropping one. Failures are
// logged instead, where the function's log will show them.
const ok = (note: string) => {
  console.log(note);
  return new Response(JSON.stringify({ ok: true, note }), {
    headers: { "Content-Type": "application/json" },
  });
};

Deno.serve(async (req) => {
  let body: { type?: string; record?: { key?: string; value?: string } };
  try {
    body = await req.json();
  } catch {
    return ok("unparseable body");
  }

  if (body.type !== "INSERT") return ok(`ignored: ${body.type}`);

  // No point re-reading the event and walking the subscription list if there
  // is no way to sign a push. Surfaced as an ordinary log line rather than a
  // boot crash (see the setVapidDetails guard above).
  if (vapidError) return ok(`cannot send push: ${vapidError}`);

  const key = body.record?.key ?? "";
  const parts = key.split(":");
  if (parts[0] !== "avail" || parts.length < 3) return ok("not an avail key");

  // The person segment can itself contain colons, so rejoin everything after
  // the date rather than taking parts[2].
  const person = parts.slice(2).join(":");
  if (!person.startsWith(EVENT_MARKER)) return ok("not an event");

  const iso = parts[1];
  const eventId = person.slice(EVENT_MARKER.length);

  // The row is re-read rather than trusted. This function's URL is public and
  // it would otherwise notify the whole group on the say-so of anyone who
  // posted a plausible body at it. Reading the event back means a
  // notification requires an event that actually exists.
  const { data: row, error: rowError } = await supabase
    .from("kv_store")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (rowError) return ok(`could not re-read the event: ${rowError.message}`);
  if (!row) return ok("no such event -- ignoring");

  let parsed: { createdBy?: string; moveSkipNotify?: boolean };
  try {
    parsed = JSON.parse(row.value ?? "{}");
  } catch {
    return ok("event value was not json");
  }

  // "Ni potrebno obvestiti" on a reschedule: the row is still an INSERT on the
  // new day, so the trigger fired, but the person moving it asked for no push.
  if (parsed.moveSkipNotify === true) return ok("move marked as no-notify");

  const creator = parsed.createdBy ?? "";

  // Matches the app's greeting, which also shows the first name only.
  const firstName = creator.trim().split(/\s+/)[0] || "Nekdo";

  // The line above these two is written by the system, not by us, and it is
  // not dependable branding: an installed app is labelled with the manifest's
  // short_name, but anything short of a real install is labelled with the
  // origin instead -- "github.io", which tells nobody anything. Carrying the
  // name ourselves costs one line and reads correctly either way.
  const title = "maš Cajt?";
  const messageBody = `${firstName} vabi na nov dogodek`;

  const { data: rows, error } = await supabase
    .from("kv_store")
    .select("key,value")
    .like("key", "push:%");
  if (error) return ok(`could not read subscriptions: ${error.message}`);

  const payload = JSON.stringify({
    title,
    body: messageBody,
    // Opens the calendar on that day rather than at the top; the app reads
    // this hash on load.
    url: `./#${iso}`,
    // Per event, so a second event stacks beside the first instead of
    // replacing it. A constant tag would collapse them into one.
    tag: `event:${iso}:${eventId}`,
  });

  const creatorKey = creator.trim().toLowerCase();
  let sent = 0;
  let skipped = 0;
  const dead: string[] = [];

  await Promise.all(
    (rows ?? []).map(async (row: { key: string; value: string }) => {
      let parsed: Subscription;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        return;
      }
      if (!parsed.subscription?.endpoint) return;

      // Nobody needs telling about their own event. This drops every device
      // that person has, which is the intent.
      if ((parsed.name ?? "").trim().toLowerCase() === creatorKey) {
        skipped++;
        return;
      }

      try {
        await webpush.sendNotification(parsed.subscription as never, payload, {
          TTL: TTL_SECONDS,
          urgency: "high",
        });
        sent++;
      } catch (e) {
        // 404/410 mean the push service has expired this subscription: the
        // browser was reinstalled, the app removed, permission revoked. It
        // will never work again, so drop the row rather than retrying it
        // forever on every future event.
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          dead.push(row.key);
        } else {
          console.error(`send failed for ${row.key}:`, status, String(e));
        }
      }
    })
  );

  if (dead.length) {
    const { error: delError } = await supabase.from("kv_store").delete().in("key", dead);
    if (delError) console.error("could not remove dead subscriptions:", delError.message);
  }

  return ok(
    `event ${iso}/${eventId} by ${creator}: sent ${sent}, skipped ${skipped}, removed ${dead.length}`
  );
});
