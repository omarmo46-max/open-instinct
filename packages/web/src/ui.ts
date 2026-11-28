/** Layout, styles and small scripts. Everything is served from our own origin, so the CSP can forbid inline code. */
export const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const ICONS: Record<string, string> = {
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/>',
  apps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.2 7.8 8 9 4.8-1.2 8-4.5 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6 15h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3M14 9l2 2"/>',
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  data: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
};

export const icon = (name: string, size = 20): string =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;

export const CSS = `
:root{--bg:#fff;--soft:#f7f8fa;--ink:#101828;--ink2:#344054;--muted:#667085;--line:#e4e7ec;--line2:#d0d5dd;--accent:#175cd3;--accent-h:#1849a9;--accent-soft:#eff4ff;--ok:#067647;--ok-soft:#ecfdf3;--bad:#b42318;--bad-soft:#fef3f2;--warn:#b54708;--warn-soft:#fffaeb;--r:8px;--shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.08)}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 Inter,"Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-h)}
h1,h2,h3,h4{margin:0;color:var(--ink);letter-spacing:-.02em;line-height:1.15}
h1{font-size:clamp(36px,5vw,56px);font-weight:650;letter-spacing:-.03em}
h2{font-size:clamp(26px,3.2vw,36px);font-weight:650}h3{font-size:18px;font-weight:600;letter-spacing:-.01em;line-height:1.3}
p{margin:0}.lead{font-size:20px;line-height:1.55;color:var(--ink2)}.muted{color:var(--muted)}.small{font-size:14px}
.wrap{max-width:1160px;margin:0 auto;padding:0 24px}.narrow{max-width:760px}
.ic{flex:none}
/* header */
.hdr{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.96);border-bottom:1px solid var(--line)}
.hdr .wrap{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;height:68px;gap:16px}
.hdr .left{display:flex;align-items:center;gap:18px}.hdr .right{display:flex;align-items:center;justify-content:flex-end;gap:26px}
.brand{white-space:nowrap;display:inline-flex;align-items:center;gap:9px;font-weight:700;font-size:19px;letter-spacing:-.02em;color:var(--ink)}.brand .mk{width:26px;height:26px;flex:none}.brand:hover{color:var(--ink)}
.nav{display:flex;gap:26px}.nav a,.hdr .right a,.link{color:var(--ink2);font-size:15px;font-weight:500}.nav a:hover,.nav a.on,.hdr .right a:hover{color:var(--ink)}
.nav a.on{box-shadow:0 2px 0 var(--accent);padding-bottom:3px}
/* buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 18px;border-radius:var(--r);border:1px solid var(--accent);background:var(--accent);color:#fff;font:600 15px/1 inherit;font-family:inherit;cursor:pointer;transition:background .15s}
.btn:hover{background:var(--accent-h);color:#fff}.btn.sm{height:36px;padding:0 14px;font-size:14px}.btn.lg{height:50px;padding:0 26px;font-size:16px}
.btn.ghost{background:#fff;color:var(--ink);border-color:var(--line2)}.btn.ghost:hover{background:var(--soft);color:var(--ink)}
.btn.danger{background:var(--bad);border-color:var(--bad)}.btn.danger:hover{background:#912018}.btn[disabled]{opacity:.55;cursor:not-allowed}
.link{background:none;border:0;padding:0;cursor:pointer;font-family:inherit}
/* sections */
.hero{padding:96px 0 72px;background:linear-gradient(#fff,var(--soft))}.hero .grid{display:grid;grid-template-columns:1.05fr .95fr;gap:56px;align-items:center}
.hero .lead{margin:22px 0 32px;max-width:540px}.hero .cta{display:flex;gap:12px;flex-wrap:wrap}.eyebrow{font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-bottom:14px}
.sec{padding:84px 0}.sec.soft{background:var(--soft);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.sec h2{max-width:680px}.sec .sub{margin-top:14px;max-width:640px;color:var(--ink2);font-size:18px}
.cols{display:grid;gap:24px;margin-top:44px}.c3{grid-template-columns:repeat(3,1fr)}.c2{grid-template-columns:repeat(2,1fr)}.c4{grid-template-columns:repeat(4,1fr)}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:26px;box-shadow:var(--shadow)}.card p{color:var(--ink2);margin-top:8px;font-size:15px}
.card .ico{display:inline-flex;width:42px;height:42px;align-items:center;justify-content:center;border-radius:10px;background:var(--accent-soft);color:var(--accent);margin-bottom:16px}
.step{display:flex;gap:16px}.step .n{flex:none;width:34px;height:34px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:650;font-size:15px}.step p{color:var(--ink2);margin-top:4px;font-size:15px}
.band{background:var(--ink);color:#fff;padding:72px 0}.band h2{color:#fff}.band p{color:#d0d5dd;margin-top:12px;font-size:18px}.band .btn{margin-top:28px;background:#fff;color:var(--ink);border-color:#fff}
/* conversation preview on the home page */
.phone{background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 12px 32px rgba(16,24,40,.12);padding:20px;max-width:440px;margin-left:auto}
.phone .bar{display:flex;align-items:center;gap:10px;padding-bottom:14px;border-bottom:1px solid var(--line);margin-bottom:16px;font-weight:600;font-size:15px}.dot{width:9px;height:9px;border-radius:50%;background:var(--ok)}
.msg{max-width:84%;padding:10px 14px;border-radius:14px;font-size:15px;margin:8px 0;line-height:1.45}.msg.me{background:var(--accent);color:#fff;margin-left:auto;border-bottom-right-radius:4px}.msg.ag{background:var(--soft);border:1px solid var(--line);border-bottom-left-radius:4px}
.tag{display:inline-block;font-size:12px;font-weight:600;padding:3px 9px;border-radius:99px;background:var(--accent-soft);color:var(--accent)}.tag.ok{background:var(--ok-soft);color:var(--ok)}.tag.bad{background:var(--bad-soft);color:var(--bad)}.tag.warn{background:var(--warn-soft);color:var(--warn)}.tag.gray{background:var(--soft);color:var(--muted);border:1px solid var(--line)}
/* page head */
.phead{padding:64px 0 40px;background:var(--soft);border-bottom:1px solid var(--line)}.phead .lead{margin-top:16px;max-width:660px}
.sub-nav{display:flex;gap:6px;flex-wrap:wrap;margin-top:28px}.sub-nav a{padding:7px 14px;border-radius:99px;border:1px solid var(--line2);color:var(--ink2);font-size:14px;font-weight:500;background:#fff}.sub-nav a:hover{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}
.feat{display:grid;grid-template-columns:260px 1fr;gap:40px;padding:48px 0;border-bottom:1px solid var(--line)}.feat:last-child{border-bottom:0}.feat ul{margin:0;padding:0;list-style:none}.feat li{display:flex;gap:12px;padding:8px 0;color:var(--ink2)}.feat li .ic{color:var(--ok);margin-top:3px}
details{border-bottom:1px solid var(--line);padding:20px 0}summary{cursor:pointer;font-weight:600;font-size:17px;list-style:none;display:flex;justify-content:space-between;gap:16px}summary::-webkit-details-marker{display:none}summary::after{content:"+";color:var(--muted);font-size:22px;line-height:1}details[open] summary::after{content:"\\2212"}details p{margin-top:12px;color:var(--ink2);max-width:720px}
.prose h2{font-size:24px;margin:40px 0 12px}.prose p,.prose li{color:var(--ink2);margin:0 0 14px}.prose ul{padding-left:22px}
/* footer */
.ftr{border-top:1px solid var(--line);background:var(--soft);padding:56px 0 28px;margin-top:0}.ftr .grid{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:32px}.ftr h4{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:14px;font-weight:600}.ftr a{display:block;color:var(--ink2);font-size:15px;padding:4px 0}.ftr a:hover{color:var(--accent)}.ftr .base{margin-top:40px;padding-top:22px;border-top:1px solid var(--line);font-size:14px;color:var(--muted);display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
/* forms */
label{display:block;font-size:14px;font-weight:600;margin:16px 0 6px;color:var(--ink2)}
input[type=text],input[type=email],input[type=password],input[type=url],select,textarea{width:100%;height:44px;padding:0 14px;border:1px solid var(--line2);border-radius:var(--r);font:inherit;font-size:15px;background:#fff;color:var(--ink)}
textarea{height:auto;padding:12px 14px}input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent)}
.hint{font-size:13px;color:var(--muted);margin-top:6px}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.stack>*+*{margin-top:16px}
.alert{border-radius:var(--r);padding:12px 14px;font-size:14px;margin:0 0 16px;border:1px solid}.alert.err{background:var(--bad-soft);border-color:#fecdca;color:var(--bad)}.alert.ok{background:var(--ok-soft);border-color:#abefc6;color:var(--ok)}.alert.info{background:var(--accent-soft);border-color:#b2ccff;color:var(--accent-h)}
/* auth page */
.authbox{max-width:440px;margin:72px auto;padding:36px;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}.authbox h1{font-size:28px;margin-bottom:8px}.authbox .btn{width:100%;margin-top:22px}.authbox .alt{margin-top:20px;text-align:center;font-size:14px;color:var(--muted)}
/* modal */
dialog{border:0;border-radius:14px;padding:0;width:min(440px,92vw);box-shadow:0 24px 64px rgba(16,24,40,.28)}dialog::backdrop{background:rgba(16,24,40,.55)}
.dlg{padding:30px}.dlg .tabs{display:flex;border-bottom:1px solid var(--line);margin:-4px 0 14px}.dlg .tabs button{flex:1;background:none;border:0;border-bottom:2px solid transparent;padding:10px 0 12px;font:600 15px inherit;font-family:inherit;color:var(--muted);cursor:pointer}.dlg .tabs button.on{color:var(--ink);border-color:var(--accent)}.dlg .x{position:absolute;right:14px;top:10px;background:none;border:0;font-size:24px;color:var(--muted);cursor:pointer}.dlg .btn{width:100%;margin-top:20px}.dlg .pane[hidden]{display:none}
/* app */
.app{display:grid;grid-template-columns:248px 1fr;min-height:100vh}.side{border-right:1px solid var(--line);background:var(--soft);padding:20px 14px;position:sticky;top:0;height:100vh;overflow:auto}
.side .brand{display:flex;padding:6px 12px 18px}.side .grp{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:18px 12px 6px}
.side a,.side .off{display:flex;align-items:center;gap:11px;padding:9px 12px;border-radius:var(--r);color:var(--ink2);font-size:15px;font-weight:500}.side a:hover{background:#eaecf0;color:var(--ink)}.side a.on{background:var(--accent-soft);color:var(--accent)}.side .off{color:#98a2b3}.side .off .tag{margin-left:auto}
.main{min-width:0}.top{height:68px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 32px;background:#fff}.top .who{display:flex;align-items:center;gap:14px;font-size:14px;color:var(--ink2)}
.content{padding:36px 32px 64px;max-width:980px}.content h1{font-size:28px;letter-spacing:-.02em}.content .desc{color:var(--muted);margin:8px 0 28px}.panel{border:1px solid var(--line);border-radius:12px;background:#fff;margin-bottom:24px}.panel>.ph{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px}.panel>.ph h3{font-size:16px}.panel>.pb{padding:22px}
.kv{display:grid;grid-template-columns:200px 1fr;gap:12px 20px;font-size:15px}.kv dt{color:var(--muted)}.kv dd{margin:0;word-break:break-word}
.stat{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}.stat .s{border:1px solid var(--line);border-radius:12px;padding:18px 20px;background:#fff}.stat .s .l{font-size:13px;color:var(--muted)}.stat .s .v{font-size:20px;font-weight:650;margin-top:6px;letter-spacing:-.01em}
.tbl{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14.5px}th{text-align:left;font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:600;padding:0 12px 10px}td{padding:12px;border-top:1px solid var(--line);vertical-align:top}
.inl{display:inline-block;margin:0 6px 4px 0}.inl select{height:36px;width:auto;margin-right:6px;font-size:14px}.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{display:inline-block}.pre{white-space:pre-wrap;word-break:break-word;background:var(--soft);border:1px solid var(--line);border-radius:var(--r);padding:14px;font:13.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;max-height:420px;overflow:auto}code{background:var(--soft);border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:13px}input[type=number]{width:150px;height:44px;padding:0 12px;border:1px solid var(--line2);border-radius:var(--r);font:inherit;font-size:15px}
@media(max-width:900px){.hero .grid,.c3,.c4,.c2,.feat,.ftr .grid{grid-template-columns:1fr}.hdr .wrap{grid-template-columns:auto 1fr}.nav{display:none}.hdr .right{gap:14px}.phone{margin:0}.app{grid-template-columns:1fr}.side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}.stat{grid-template-columns:1fr}.kv{grid-template-columns:1fr}.top{padding:0 18px}.content{padding:24px 18px}.hero{padding:64px 0 48px}.sec{padding:56px 0}}
`;

export const JS = `
(function(){
  var dlg=document.getElementById('auth-dialog');
  function open(tab){if(!dlg||!dlg.showModal)return false;dlg.showModal();pick(tab||'signup');return true}
  function pick(tab){if(!dlg)return;dlg.querySelectorAll('.tabs button').forEach(function(b){b.classList.toggle('on',b.dataset.tab===tab)});dlg.querySelectorAll('.pane').forEach(function(p){p.hidden=p.dataset.pane!==tab})}
  document.addEventListener('click',function(e){
    var t=e.target.closest('[data-auth]');if(t&&dlg&&dlg.showModal){e.preventDefault();open(t.dataset.auth);return}
    var b=e.target.closest('.tabs button');if(b){pick(b.dataset.tab);return}
    if(e.target.closest('[data-close]')&&dlg){dlg.close();return}
    if(e.target===dlg){dlg.close()}
    var c=e.target.closest('[data-copy]');if(c&&navigator.clipboard){navigator.clipboard.writeText(c.dataset.copy);c.textContent='Copied'}
  });
})();
`;
