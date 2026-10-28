// Independent identity page; eye-care palette mirrors src/index.css without
// loading the application bundle. Base #e6f0e0, surface #f1f6ec, accent #44764e.
export const AUTH_STYLE = `
*{box-sizing:border-box}
body.auth-entry{--page-bg:#e6f0e0;--surface:#e9f1e2;--text:#2b3a22;--secondary:#3c5230;--muted:#506646;--accent:#44764e;--line:#c4cdbd;margin:0;background:var(--page-bg);color:var(--text);font:14px/1.65 Inter,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color-scheme:light}
.auth-entry :is(h1,h2,p){margin:0}
.auth-entry .split{position:relative;isolation:isolate;display:grid;grid-template-columns:1.15fr 1fr;min-height:100vh;min-height:100dvh;max-width:1800px;margin:auto;background:radial-gradient(ellipse at 22% 32%,#c4d9b180,transparent 52%),radial-gradient(ellipse at 75% 80%,#d1e1c650,transparent 48%)}
.auth-entry .panel{position:relative;min-width:0;display:flex;flex-direction:column;justify-content:space-between;padding:48px clamp(36px,5vw,88px);overflow:hidden;border-right:1px solid rgba(60,82,48,.08)}
.auth-entry .panel::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.5;background:radial-gradient(1px 1px at 16% 19%,#638c5b 95%,transparent),radial-gradient(1px 1px at 83% 14%,#638c5b 95%,transparent),radial-gradient(1px 1px at 72% 53%,#638c5b 95%,transparent),radial-gradient(1px 1px at 12% 68%,#638c5b 95%,transparent),radial-gradient(1px 1px at 91% 76%,#638c5b 95%,transparent)}
.auth-entry .brand{position:relative;display:flex;align-items:center;gap:12px;z-index:1}
.auth-entry .logo{display:flex;align-items:center;justify-content:center;width:44px;height:44px;flex:none;border:1px solid #44764e33;border-radius:13px;background:#44764e08}
.auth-entry .logo svg{width:28px;height:28px;fill:#44764e}
.auth-entry .brand-name{font-size:18px;letter-spacing:.12em;font-weight:600}
.auth-entry .brand-en{color:var(--muted);font-size:10px;letter-spacing:.17em;margin-top:1px}
.auth-entry .story{position:relative;z-index:1;margin:56px 0 16px;animation:night-rise .5s ease both}
.auth-entry .eyebrow{display:flex;align-items:center;gap:10px;color:#44764e;font-size:11px;letter-spacing:.18em;margin-bottom:20px}
.auth-entry .eyebrow::before{content:"";width:24px;height:1px;background:#44764e80}
.auth-entry h1{font:500 clamp(38px,4vw,52px)/1.5 "Noto Serif SC","Source Han Serif SC","Songti SC",SimSun,serif;letter-spacing:.06em}
.auth-entry h1 span{color:#44764e}
.auth-entry .story-lead{font-size:16px;color:var(--secondary);margin-top:20px;line-height:1.9}
.auth-entry .story-note{max-width:330px;margin-top:12px;color:var(--muted);font-size:13px;line-height:1.9}
.auth-entry .night-art{display:block;position:relative;width:min(100%,460px);height:auto;max-height:290px;margin:8px auto 0;overflow:visible}
.auth-entry .brand-foot{position:relative;display:flex;justify-content:space-between;align-items:center;gap:16px;border-top:1px solid var(--line);padding-top:20px;font-size:11px;letter-spacing:.08em;color:var(--muted)}
.auth-entry .brand-foot span:last-child{color:#44764e}
.auth-entry .stage{min-width:0;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:48px 28px;gap:24px}
.auth-entry .card{width:100%;max-width:440px;padding:32px;border-radius:20px;border:1px solid var(--line);background:#f1f6ec;box-shadow:0 24px 80px #2b3a2212;animation:night-rise .4s ease both}
@supports(backdrop-filter:blur(18px)){.auth-entry .card{background:rgba(241,246,236,.9);backdrop-filter:blur(18px)}}
.auth-entry .card-kicker{color:var(--accent);font-size:10px;letter-spacing:.16em;margin-bottom:6px}
.auth-entry h2{font-size:28px;font-weight:600;line-height:1.4;letter-spacing:.03em}
.auth-entry .card-subtitle{margin-top:4px;color:var(--muted);font-size:14px}
.auth-entry .tabs{display:flex;gap:4px;border:1px solid rgba(60,82,48,.08);background:#dce8d480;padding:4px;border-radius:12px;margin:24px 0 16px}
.auth-entry button{font:inherit;cursor:pointer}
.auth-entry .tabs button{flex:1;min-height:40px;background:transparent;border:0;border-radius:8px;color:var(--muted);transition:background .2s,color .2s}
.auth-entry .tabs button.on{background:#f1f6ec;color:#2b3a22;box-shadow:inset 0 0 0 1px #44764e;font-weight:600}
.auth-entry label{display:block;color:var(--secondary);font-size:13px;margin:14px 0 8px}
.auth-entry input{display:block;width:100%;height:50px;min-width:0;border:1px solid #7a8e6e;border-radius:14px;background:#f6f9f2;color:var(--text);padding:12px 16px;font-family:inherit;font-size:16px;line-height:1.5;transition:border-color .18s,box-shadow .18s,background .18s}
.auth-entry input::placeholder{color:#506646;font-size:14px;opacity:1}
.auth-entry input:hover{border-color:#506646}
.auth-entry input:focus{outline:2px solid #44764e;outline-offset:2px;border-color:#44764e;box-shadow:0 0 0 5px #44764e1a}
.auth-entry input[aria-invalid=true]{border-color:#b91c1c}
.auth-entry .password-wrap{position:relative}
.auth-entry .password-wrap input{padding-right:56px}
.auth-entry .password-toggle{position:absolute;right:4px;top:3px;width:44px;height:44px;display:grid;place-items:center;background:transparent;border:0;border-radius:10px;color:var(--muted)}
.auth-entry .password-toggle:hover{color:var(--text);background:#44764e0d}
.auth-entry .password-toggle[aria-pressed=true]{color:#315c39;background:#44764e20}
.auth-entry .icon{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex:none}
.auth-entry .field-error{font-size:12px;color:#b91c1c;margin-top:8px}
.auth-entry .field-note{font-size:12px;color:var(--muted);margin-top:8px}
.auth-entry .forgot{margin-top:4px;text-align:right;font-size:12px}
.auth-entry a{color:#38643e;text-decoration:none;text-underline-offset:4px;overflow-wrap:anywhere}
.auth-entry a:hover{text-decoration:underline;color:#315c39}
.auth-entry .forgot a{display:inline-flex;align-items:center;min-height:44px}
.auth-entry .submit{width:100%;min-height:52px;display:flex;align-items:center;justify-content:center;gap:10px;margin-top:12px;border:1px solid #315c3938;border-radius:14px;background:linear-gradient(100deg,#44764e,#4d7953);color:#fff;font-size:16px;font-weight:600;transition:transform .18s,box-shadow .18s}
.auth-entry .submit:not(:disabled):hover{transform:translateY(-1px);box-shadow:0 8px 24px #44764e30}
.auth-entry .submit:active{transform:none}
.auth-entry form[aria-busy=true] .submit::before{content:"";width:15px;height:15px;border:2px solid #ffffff55;border-top-color:#fff;border-radius:50%;animation:night-spin .8s linear infinite}
.auth-entry .cancel{width:100%;min-height:44px;margin-top:8px;border:1px solid var(--line);border-radius:12px;background:transparent;color:var(--secondary)}
.auth-entry .msg{display:none;margin-top:16px;padding:12px;border-radius:10px;font-size:13px;overflow-wrap:anywhere}
.auth-entry .msg.err{display:block;background:#b91c1c10;border:1px solid #b91c1c50;color:#b91c1c}
.auth-entry .msg.ok{display:block;background:#15803d10;border:1px solid #15803d50;color:#166534}
.auth-entry .orDivider{display:flex;align-items:center;gap:12px;margin:20px 0 12px;color:var(--muted);font-size:11px}
.auth-entry .orDivider::before,.auth-entry .orDivider::after{content:"";height:1px;flex:1;background:var(--line)}
.auth-entry .guestBtn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:48px;padding:10px 8px;border:1px solid #3c52302e;border-radius:14px;color:var(--secondary);transition:background .18s,border-color .18s}
.auth-entry .guestBtn:hover{background:#44764e08;border-color:#44764e88;color:var(--text);text-decoration:none}
.auth-entry .guestNote{margin-top:10px;text-align:center;font-size:12px;color:var(--muted);line-height:1.9}
.auth-entry .guestNote b{font-weight:500;color:var(--secondary)}
.auth-entry .foot{width:100%;max-width:440px;text-align:center;color:var(--muted);font-size:12px;line-height:1.9}
.auth-entry .cloud-note{display:flex;justify-content:center;align-items:center;gap:7px;color:var(--secondary);margin-bottom:4px}
.auth-entry .cloud-note .icon{width:14px;height:14px;color:#44764e}
.auth-entry .dl{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:16px;padding-top:16px;border-top:1px solid var(--line)}
.auth-entry .dl a{min-height:32px;display:inline-flex;align-items:center;gap:8px}
.auth-entry [hidden]{display:none!important}
.auth-entry button:disabled{cursor:wait;opacity:.65}
.auth-entry input:disabled{opacity:.7;cursor:wait}
.auth-entry :is(button,a,.msg):focus-visible{outline:2px solid #38643e;outline-offset:4px}
.auth-entry .msg:focus{outline:2px solid #38643e;outline-offset:3px}
@keyframes night-rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes night-spin{to{transform:rotate(360deg)}}
@media(min-width:1600px){.auth-entry .stage{padding-top:64px;padding-bottom:64px}.auth-entry .story{margin-top:80px}.auth-entry .night-art{max-height:330px}}
@media(min-width:1024px) and (max-height:850px){.auth-entry .stage{padding-top:24px;padding-bottom:24px;gap:20px}.auth-entry .card{padding:24px 32px}.auth-entry .panel{padding-top:32px;padding-bottom:32px}.auth-entry .story{margin-top:32px}.auth-entry .night-art{max-height:220px}}
@media(max-width:1023px){.auth-entry .split{grid-template-columns:1fr}.auth-entry .panel{padding:32px 32px 0;border:0;align-items:center;text-align:center}.auth-entry .story{margin:28px 0 0}.auth-entry h1{font-size:34px}.auth-entry h1 br{display:none}.auth-entry .story-lead{font-size:14px;margin-top:8px}.auth-entry .eyebrow,.auth-entry .story-note,.auth-entry .night-art,.auth-entry .brand-foot{display:none}.auth-entry .stage{padding-top:28px}.auth-entry .brand{text-align:left}}
@media(max-width:480px){.auth-entry .panel{padding:24px 20px 0}.auth-entry .brand-name{font-size:16px}.auth-entry .brand-en{font-size:9px}.auth-entry .logo{width:40px;height:40px}.auth-entry .story{margin-top:24px}.auth-entry h1{font-size:28px;letter-spacing:.02em}.auth-entry .story-lead{max-width:260px;font-size:13px}.auth-entry .stage{padding:24px 16px max(28px,env(safe-area-inset-bottom));gap:20px}.auth-entry .card{padding:24px 20px}.auth-entry h2{font-size:24px}.auth-entry .tabs{margin-top:24px}.auth-entry .foot{font-size:12px}}
@media(prefers-reduced-motion:reduce){.auth-entry *,.auth-entry *::before,.auth-entry *::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media(forced-colors:active){.auth-entry .card,.auth-entry input,.auth-entry .tabs,.auth-entry button,.auth-entry .guestBtn,.auth-entry .msg{border:1px solid CanvasText}.auth-entry .tabs button.on{outline:2px solid Highlight;outline-offset:-3px}.auth-entry .submit{background:ButtonFace;color:ButtonText}.auth-entry :is(button,a,input,.msg):focus-visible{outline-color:Highlight}.auth-entry .night-art{display:none}}
`
