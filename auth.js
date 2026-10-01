// Prijava prek Supabase Auth (e-pošta + geslo) -- isti računi kot v hubu
// TomStudios in ostalih aplikacijah (projekt ProjektiBaze). Koledar se
// izriše šele, ko je seja na voljo: RLS na kv_store in v bucketu arhiv
// spušča samo prijavljene, zato bi anonimni izris pokazal prazen koledar.
//
// Iz huba se prijava zgodi sama, na dva načina:
// - hub doda #sb_at=…&sb_rt=… v povezavo (dashboard.js buildAppUrl), to
//   prevzamemo s setSession in takoj počistimo iz naslova;
// - tudi brez tega hub in ta aplikacija delita izvor (zig4to.github.io),
//   zato supabase-js najde hubovo sejo v localStorage (isti projekt, isti
//   privzeti storageKey).
//
// Ime osebe v koledarju je s tem namenoma nepovezano: še vedno ga vsak
// izbere na napravi ("my-name"), da se obstoječi vnosi ne razcepijo zaradi
// drugače zapisanega imena v računu.

const $ = (id) => document.getElementById(id);

function prevediNapako(msg) {
  msg = msg || "Nekaj je šlo narobe.";
  if (/Invalid login credentials/i.test(msg)) return "Napačna e-pošta ali geslo.";
  if (/signup_not_allowed|database error saving new user/i.test(msg))
    return readInvite()
      ? "Povezava z vabilom je že porabljena ali ni veljavna. Prosi za novo."
      : "Za registracijo potrebuješ povezavo z vabilom.";
  if (/already registered|already been registered|user already exists/i.test(msg))
    return "Ta e-pošta je že registrirana. Prijavi se.";
  if (/Password should be at least|at least 6/i.test(msg)) return "Geslo mora imeti vsaj 6 znakov.";
  if (/New password should be different/i.test(msg)) return "Novo geslo mora biti drugačno od starega.";
  if (/Auth session missing|session_not_found|JWT expired/i.test(msg))
    return "Seja je potekla. Zahtevaj novo povezavo za ponastavitev.";
  if (/Unable to validate email address|invalid format/i.test(msg)) return "Neveljaven e-poštni naslov.";
  if (/Email not confirmed/i.test(msg)) return "E-pošta še ni potrjena. Preveri predal.";
  if (/rate limit|too many|after \d+ seconds|for security purposes/i.test(msg))
    return "Preveč poskusov. Počakaj malo in poskusi znova.";
  return msg;
}

// Koda vabila iz povezave ?vabilo=<koda> -- ista kot v hubu (tabela
// invite_codes v ProjektiBaze, preverja jo sprožilec ob registraciji).
// Isti ključ v localStorage kot hub: izvor je skupen, zato vabilo, odprto
// v hubu, velja tudi tu in obratno. Iz naslova jo odstranimo, da ne obtiči
// v zaznamkih ali nameščeni aplikaciji.
const INVITE_KEY = "ptomsetu-invite";
function readInvite() {
  try {
    return localStorage.getItem(INVITE_KEY);
  } catch (e) {
    return null;
  }
}
function captureInvite() {
  try {
    const params = new URLSearchParams(location.search);
    const code = params.get("vabilo");
    if (!code) return;
    localStorage.setItem(INVITE_KEY, code);
    params.delete("vabilo");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
  } catch (e) {}
}

// Napaka iz povezave v e-pošti (npr. potekla povezava za ponastavitev) pride
// kot #error=…; preberemo jo, preden jo supabase-js pobriše.
function readHashError() {
  const h = location.hash || "";
  if (h.indexOf("error") === -1) return null;
  const p = new URLSearchParams(h.replace(/^#/, ""));
  const code = p.get("error_code") || p.get("error") || "";
  const desc = p.get("error_description") || "";
  if (!code && !desc) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return /expired|invalid/i.test(code + " " + desc)
    ? "Povezava je potekla ali je bila že uporabljena. Zahtevaj novo."
    : desc || "Povezava ni veljavna.";
}

async function adoptHubSession(sb) {
  const h = location.hash || "";
  if (h.indexOf("sb_at=") === -1 || h.indexOf("sb_rt=") === -1) return;
  const params = new URLSearchParams(h.replace(/^#/, ""));
  const access_token = params.get("sb_at");
  const refresh_token = params.get("sb_rt");
  params.delete("sb_at");
  params.delete("sb_rt");
  const rest = params.toString();
  // Žeton takoj iz naslovne vrstice in zgodovine, še preden karkoli čakamo.
  history.replaceState(null, "", location.pathname + location.search + (rest ? "#" + rest : ""));
  if (!access_token || !refresh_token) return;
  try {
    await sb.auth.setSession({ access_token, refresh_token });
  } catch (e) {
    // Tiho: če žeton ne velja več, ostane navaden prijavni zaslon.
  }
}

// Vrne obljubo, ki se razreši s sejo, ko je uporabnik prijavljen (in ni sredi
// nastavljanja novega gesla). Do takrat prikazuje prijavni zaslon.
export async function requireSignIn(sb) {
  const authScreen = $("authScreen");
  const recoveryScreen = $("recoveryScreen");
  const loading = $("authLoading");

  const form = $("authForm");
  const emailEl = $("authEmail");
  const passEl = $("authPassword");
  const submitBtn = $("authSubmit");
  const toggleBtn = $("authToggle");
  const forgotBtn = $("authForgot");
  const titleEl = $("authTitle");
  const errEl = $("authError");
  const noteEl = $("authNote");

  const recForm = $("recoveryForm");
  const recPass1 = $("recoveryPassword");
  const recPass2 = $("recoveryPassword2");
  const recSubmit = $("recoverySubmit");
  const recErr = $("recoveryError");

  captureInvite();
  let recovering = location.hash.indexOf("type=recovery") !== -1;
  let pendingError = readHashError();
  let mode = "signin";
  let resolveSignedIn;
  const signedIn = new Promise((r) => (resolveSignedIn = r));

  function hideAll() {
    loading.hidden = true;
    authScreen.hidden = true;
    recoveryScreen.hidden = true;
  }
  function done(session) {
    if (recovering || !session) return;
    hideAll();
    resolveSignedIn(session);
  }
  function showAuth() {
    hideAll();
    authScreen.hidden = false;
    if (pendingError) {
      errEl.textContent = pendingError;
      pendingError = null;
    }
  }
  function showRecovery() {
    recovering = true;
    hideAll();
    recoveryScreen.hidden = false;
    recPass1.value = "";
    recPass2.value = "";
    recErr.textContent = "";
    recPass1.focus();
  }

  function setMode(m) {
    mode = m;
    errEl.textContent = "";
    noteEl.textContent = "";
    const signup = m === "signup";
    titleEl.textContent = signup ? "Registracija" : "Prijava";
    submitBtn.textContent = signup ? "Ustvari račun" : "Prijava";
    toggleBtn.textContent = signup ? "Že imaš račun? Prijava" : "Nimaš računa? Registracija";
    forgotBtn.hidden = signup;
    passEl.autocomplete = signup ? "new-password" : "current-password";
  }
  // S povezavo z vabilom pride nekdo, da se registrira.
  setMode(readInvite() ? "signup" : "signin");

  toggleBtn.addEventListener("click", () => setMode(mode === "signin" ? "signup" : "signin"));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = emailEl.value.trim();
    const password = passEl.value;
    errEl.textContent = "";
    noteEl.textContent = "";
    if (!email || !password) {
      errEl.textContent = "Vpiši e-pošto in geslo.";
      return;
    }
    submitBtn.disabled = true;
    try {
      const invite = readInvite();
      const res =
        mode === "signup"
          ? await sb.auth.signUp({
              email,
              password,
              options: {
                emailRedirectTo: location.origin + location.pathname,
                ...(invite ? { data: { invite } } : {}),
              },
            })
          : await sb.auth.signInWithPassword({ email, password });
      if (res.error) {
        errEl.textContent = prevediNapako(res.error.message);
      } else if (mode === "signup") {
        try {
          localStorage.removeItem(INVITE_KEY);
        } catch (e) {}
        if (res.data?.user && !res.data.session) {
          setMode("signin");
          noteEl.textContent = "Račun je ustvarjen. Potrdi e-pošto, nato se prijavi.";
        }
      }
    } catch (err) {
      errEl.textContent = prevediNapako(String(err?.message || err));
    }
    submitBtn.disabled = false;
  });

  forgotBtn.addEventListener("click", async () => {
    const email = emailEl.value.trim();
    errEl.textContent = "";
    noteEl.textContent = "";
    if (!email) {
      errEl.textContent = "Vpiši e-pošto, nato klikni Pozabljeno geslo.";
      emailEl.focus();
      return;
    }
    forgotBtn.disabled = true;
    try {
      const res = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: location.origin + location.pathname,
      });
      if (res.error) errEl.textContent = prevediNapako(res.error.message);
      else
        noteEl.textContent =
          "Če račun obstaja, smo poslali povezavo za novo geslo. Preveri e-pošto.";
    } catch (err) {
      errEl.textContent = prevediNapako(String(err?.message || err));
    }
    forgotBtn.disabled = false;
  });

  recForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    recErr.textContent = "";
    const p1 = recPass1.value;
    if (p1.length < 6) return void (recErr.textContent = "Geslo mora imeti vsaj 6 znakov.");
    if (p1 !== recPass2.value) return void (recErr.textContent = "Gesli se ne ujemata.");
    recSubmit.disabled = true;
    try {
      const res = await sb.auth.updateUser({ password: p1 });
      if (res.error) {
        recErr.textContent = prevediNapako(res.error.message);
      } else {
        recovering = false;
        const { data } = await sb.auth.getSession();
        if (data?.session) done(data.session);
        else {
          setMode("signin");
          showAuth();
        }
      }
    } catch (err) {
      recErr.textContent = prevediNapako(String(err?.message || err));
    }
    recSubmit.disabled = false;
  });

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") return showRecovery();
    if (event === "INITIAL_SESSION") return;
    // Seja je ugasnila med uporabo (odjava v drugem zavihku, preklican
    // žeton): koledar brez nje ne more več brati, zato na prijavni zaslon.
    if (event === "SIGNED_OUT") return void location.reload();
    if (session) done(session);
  });

  await adoptHubSession(sb);
  if (recovering) {
    showRecovery();
  } else {
    const { data } = await sb.auth.getSession();
    if (data?.session) done(data.session);
    else showAuth();
  }
  return signedIn;
}
