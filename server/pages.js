// Server-rendered sign-in page. Deliberately script-free so it works under the
// strict Content-Security-Policy.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ERRORS = {
  domain: 'Please sign in with your ArcSite Google Workspace account.',
  deactivated: 'Your Mission Control access has been turned off. Ask an admin to re-enable it.',
  expired: 'The sign-in attempt expired. Please try again.',
  cancelled: 'Sign-in was cancelled.',
  google: 'Google sign-in failed. Please try again.',
  email: 'Enter a valid email address.',
};

export function loginPage({ google, devLogin, devUsers, error, domains }) {
  const message = error ? ERRORS[error] || 'Sign-in failed. Please try again.' : '';
  const domainText = domains.length ? domains.map((d) => '@' + d).join(', ') : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in · Mission Control</title>
<link rel="stylesheet" href="/fonts.css" />
<style>
  :root{--bg:#fcfcf9;--panel:#fff;--ink:#262626;--ink-2:#737373;--ink-3:#a3a3a3;--line:#e6e3dd;--line-strong:#cccccc;--off:#dd2222;--off-bg:#fad7d7}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--ink);
       font:13px/1.45 "IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px}
  .card{width:360px;max-width:100%;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:28px 26px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .brand{display:flex;align-items:center;gap:11px;margin-bottom:22px}
  .brand-icon{width:36px;height:36px;border-radius:8px;background:#1f1d18;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px}
  .brand-title{font-size:15px;font-weight:600;line-height:1.15}
  .brand-sub{font-size:10px;color:var(--ink-2);letter-spacing:.66px;text-transform:uppercase}
  h1{font-size:16px;font-weight:600;margin:0 0 4px}
  p{margin:0 0 18px;color:var(--ink-2)}
  .google{display:flex;align-items:center;justify-content:center;gap:10px;height:38px;border:1px solid var(--line-strong);border-radius:6px;
          color:var(--ink);text-decoration:none;font-weight:500;background:#fff}
  .google:hover{background:#faf8f3}
  .google svg{width:18px;height:18px}
  .err{background:var(--off-bg);color:#8f1515;border-radius:6px;padding:8px 10px;margin-bottom:14px;font-size:12px}
  .dev{margin-top:22px;padding-top:16px;border-top:1px dashed var(--line-strong)}
  .dev h2{font-size:10px;letter-spacing:.6px;text-transform:uppercase;color:#a36100;margin:0 0 8px}
  .dev a{display:block;padding:5px 8px;border-radius:5px;color:var(--ink);text-decoration:none}
  .dev a:hover{background:#f1efe9}
  .dev a span{color:var(--ink-3);font-size:11px;margin-left:6px}
  .dev form{display:flex;gap:6px;margin-top:8px}
  .dev input{flex:1;min-width:0;height:30px;border:1px solid var(--line-strong);border-radius:5px;padding:0 8px;font:inherit}
  .dev button{height:30px;border:1px solid #1f1d18;background:#1f1d18;color:#fff;border-radius:5px;padding:0 12px;font:inherit;cursor:pointer}
</style>
</head>
<body>
  <main class="card">
    <div class="brand">
      <div class="brand-icon">M</div>
      <div><div class="brand-title">Mission Control</div><div class="brand-sub">ArcSite Project Kanban</div></div>
    </div>
    <h1>Sign in</h1>
    <p>Use your ArcSite Google account${domainText ? ` (${esc(domainText)})` : ''}.</p>
    ${message ? `<div class="err" role="alert">${esc(message)}</div>` : ''}
    ${
      google
        ? `<a class="google" href="/auth/google">
      <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
      Continue with Google
    </a>`
        : ''
    }
    ${
      devLogin
        ? `<section class="dev">
      <h2>Local development sign-in</h2>
      ${devUsers.map((u) => `<a href="/auth/dev-login?email=${encodeURIComponent(u.email)}">${esc(u.name)}<span>${esc(u.email)}</span></a>`).join('')}
      <form method="get" action="/auth/dev-login">
        <input name="email" type="email" placeholder="any.email@arcsite.com" required />
        <button type="submit">Sign in</button>
      </form>
    </section>`
        : ''
    }
  </main>
</body>
</html>`;
}
