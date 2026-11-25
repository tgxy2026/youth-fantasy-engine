// Independent identity page; neutral obsidian Workshop aesthetic mirrors
// Direction B (src/index.css) without loading the application bundle.
export const AUTH_STYLE = `
*{box-sizing:border-box}
body.auth-entry{--page-bg:#0b0c0e;--surface:#12141a;--surface-alt:#171a22;--text:#edf0f5;--secondary:#b9c1cf;--muted:#7f899c;--accent:#e5a93c;--accent-hover:#f0be5e;--line:rgba(255,255,255,.09);margin:0;background:var(--page-bg);color:var(--text);font:14px/1.65 Inter,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color-scheme:dark}
.auth-entry :is(h1,h2,p){margin:0}
.auth-entry .split{position:relative;isolation:isolate;display:grid;grid-template-columns:1.15fr 1fr;min-height:100vh;min-height:100dvh;background:radial-gradient(ellipse at 22% 30%,rgba(229,169,60,.07),transparent 54%),radial-gradient(ellipse at 78% 82%,rgba(120,140,180,.06),transparent 50%)}
.auth-entry .panel{position:relative;min-width:0;display:flex;flex-direction:column;justify-content:space-between;padding:40px clamp(28px,3vw,56px);overflow:hidden;border-right:1px solid var(--line)}
.auth-entry .panel::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.28;background:radial-gradient(1px 1px at 16% 19%,#e5a93c 95%,transparent),radial-gradient(1px 1px at 83% 14%,#8b95a7 95%,transparent),radial-gradient(1px 1px at 72% 53%,#8b95a7 95%,transparent),radial-gradient(1px 1px at 12% 68%,#e5a93c 95%,transparent),radial-gradient(1px 1px at 91% 76%,#8b95a7 95%,transparent)}
.auth-entry .brand{position:relative;display:flex;align-items:center;gap:12px;z-index:1}
.auth-entry .logo{display:flex;align-items:center;justify-content:center;width:42px;height:42px;flex:none;border:1px solid rgba(229,169,60,.3);border-radius:11px;background:rgba(229,169,60,.1);box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
.auth-entry .logo svg{width:24px;height:24px;fill:var(--accent)}
.auth-entry .brand-name{font-size:17px;letter-spacing:.08em;font-weight:600;color:var(--text)}
.auth-entry .brand-en{color:var(--muted);font-size:10px;letter-spacing:.17em;margin-top:1px}
.auth-entry .story{position:relative;z-index:1;margin:28px 0 16px;animation:night-rise .5s ease both}
.auth-entry .eyebrow{display:flex;align-items:center;gap:10px;color:var(--accent);font-size:11px;letter-spacing:.18em;margin-bottom:18px}
.auth-entry .eyebrow::before{content:"";width:24px;height:1px;background:rgba(229,169,60,.6)}
.auth-entry h1{font:500 clamp(32px,3vw,46px)/1.35 "Noto Serif SC","Source Han Serif SC","Songti SC",SimSun,serif;letter-spacing:.05em;color:var(--text)}
.auth-entry h1 br{display:none}
.auth-entry h1 span{color:var(--accent)}
.auth-entry .story-lead{font-size:15px;color:var(--secondary);margin-top:8px;line-height:1.7}
.auth-entry .story-note{max-width:none;margin-top:4px;color:var(--muted);font-size:13px;line-height:1.7}
.auth-entry .story-note br{display:none}
.auth-entry .night-art{display:block;position:relative;width:min(100%,460px);height:auto;max-height:290px;margin:8px auto 0;overflow:visible}
.auth-entry .party-art{display:block;width:100%;height:auto;margin:16px auto 0;border-radius:14px;border:1px solid rgba(255,255,255,.08);box-shadow:0 14px 36px rgba(0,0,0,.45)}
.auth-entry .art-credit{text-align:center;color:var(--muted);font-size:11px;margin-top:8px}
.auth-entry .brand-foot{position:relative;display:flex;justify-content:space-between;align-items:center;gap:16px;border-top:1px solid var(--line);padding-top:18px;font-size:11px;letter-spacing:.08em;color:var(--muted)}
.auth-entry .brand-foot span:last-child{color:var(--accent)}
.auth-entry .stage{min-width:0;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:48px 28px;gap:22px}
.auth-entry .card{width:100%;max-width:440px;padding:30px;border-radius:16px;border:1px solid var(--line);background:var(--surface);box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 24px 64px rgba(0,0,0,.55);animation:night-rise .4s ease both}
@supports(backdrop-filter:blur(18px)){.auth-entry .card{background:rgba(18,20,26,.92);backdrop-filter:blur(18px)}}
.auth-entry .card-kicker{color:var(--accent);font-size:10px;letter-spacing:.16em;margin-bottom:6px}
.auth-entry h2{font-size:26px;font-weight:600;line-height:1.35;letter-spacing:-.01em;color:var(--text)}
.auth-entry .card-subtitle{margin-top:4px;color:var(--muted);font-size:13px}
.auth-entry .tabs{display:flex;gap:4px;border:1px solid var(--line);background:#0e1015;padding:4px;border-radius:10px;margin:22px 0 16px}
.auth-entry button{font:inherit;cursor:pointer}
.auth-entry .tabs button{flex:1;min-height:38px;background:transparent;border:0;border-radius:7px;color:var(--muted);transition:background .15s,color .15s}
.auth-entry .tabs button:hover{color:var(--secondary)}
.auth-entry .tabs button.on{background:#1c202a;color:var(--text);box-shadow:inset 0 0 0 1px rgba(229,169,60,.45);font-weight:600}
.auth-entry label{display:block;color:var(--secondary);font-size:12px;font-weight:500;margin:14px 0 7px}
.auth-entry input{display:block;width:100%;height:46px;min-width:0;border:1px solid rgba(255,255,255,.12);border-radius:10px;background:#0e1015;color:var(--text);padding:10px 14px;font-family:inherit;font-size:15px;line-height:1.5;transition:border-color .15s,box-shadow .15s,background .15s}
.auth-entry input::placeholder{color:var(--muted);font-size:13px;opacity:1}
.auth-entry input:hover{border-color:rgba(255,255,255,.22)}
.auth-entry input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent);box-shadow:0 0 0 4px rgba(229,169,60,.16)}
.auth-entry input[aria-invalid=true]{border-color:#f87171}
.auth-entry .password-wrap{position:relative}
.auth-entry .password-wrap input{padding-right:52px}
.auth-entry .password-toggle{position:absolute;right:4px;top:3px;width:40px;height:40px;display:grid;place-items:center;background:transparent;border:0;border-radius:8px;color:var(--muted)}
.auth-entry .password-toggle:hover{color:var(--text);background:rgba(255,255,255,.06)}
.auth-entry .password-toggle[aria-pressed=true]{color:var(--accent);background:rgba(229,169,60,.14)}
.auth-entry .icon{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex:none}
.auth-entry .field-error{font-size:12px;color:#f87171;margin-top:6px}
.auth-entry .field-note{font-size:12px;color:var(--muted);margin-top:6px}
.auth-entry .forgot{margin-top:4px;text-align:right;font-size:12px}
.auth-entry a{color:var(--accent);text-decoration:none;text-underline-offset:4px;overflow-wrap:anywhere}
.auth-entry a:hover{text-decoration:underline;color:var(--accent-hover)}
.auth-entry .forgot a{display:inline-flex;align-items:center;min-height:40px}
.auth-entry .submit{width:100%;min-height:46px;display:flex;align-items:center;justify-content:center;gap:10px;margin-top:12px;border:1px solid var(--accent);border-radius:10px;background:var(--accent);color:#0b0c0e;font-size:15px;font-weight:600;transition:background .15s,border-color .15s,transform .15s,box-shadow .15s}
.auth-entry .submit:not(:disabled):hover{background:var(--accent-hover);border-color:var(--accent-hover);box-shadow:0 6px 20px rgba(229,169,60,.24)}
.auth-entry .submit:active{transform:none}
.auth-entry form[aria-busy=true] .submit::before{content:"";width:15px;height:15px;border:2px solid rgba(11,12,14,.35);border-top-color:#0b0c0e;border-radius:50%;animation:night-spin .8s linear infinite}
.auth-entry form[aria-busy=true] .submit.secondary::before{border:2px solid rgba(255,255,255,.25);border-top-color:var(--text)}
.auth-entry .cancel{width:100%;min-height:42px;margin-top:8px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--secondary)}
.auth-entry .msg{display:none;margin-top:14px;padding:11px 12px;border-radius:10px;font-size:13px;overflow-wrap:anywhere}
.auth-entry .msg.err{display:block;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.32);color:#fca5a5}
.auth-entry .msg.ok{display:block;background:rgba(74,222,128,.1);border:1px solid rgba(74,222,128,.32);color:#86efac}
.auth-entry .orDivider{display:flex;align-items:center;gap:12px;margin:20px 0 12px;color:var(--muted);font-size:11px}
.auth-entry .orDivider::before,.auth-entry .orDivider::after{content:"";height:1px;flex:1;background:var(--line)}
.auth-entry .guestBtn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:46px;margin-top:18px;padding:10px 12px;border:1px solid var(--accent);border-radius:10px;background:var(--accent);color:#0b0c0e;font-weight:600;transition:background .15s,border-color .15s,box-shadow .15s}
.auth-entry .guestBtn:hover{background:var(--accent-hover);border-color:var(--accent-hover);color:#0b0c0e;text-decoration:none;box-shadow:0 6px 20px rgba(229,169,60,.24)}
/* 账号表单的提交键是次要动线（首访主 CTA 是上面的游客入口）；重置页的提交键才是本页唯一动作。 */
.auth-entry .submit.secondary{background:var(--surface-alt);color:var(--text);border-color:rgba(255,255,255,.14);font-weight:500}
.auth-entry .submit.secondary:not(:disabled):hover{background:#1f232e;border-color:rgba(229,169,60,.45);box-shadow:none}
.auth-entry .resetNote{margin-top:16px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:#0e1015;color:var(--muted);font-size:12px;line-height:1.85}
.auth-entry .resetNote strong{color:var(--secondary);font-weight:600}
.auth-entry .invite-info{margin-top:14px;color:var(--muted);font-size:12px;line-height:1.8}
.auth-entry .guestNote{margin-top:10px;text-align:center;font-size:12px;color:var(--muted);line-height:1.85}
.auth-entry .guestNote b{font-weight:500;color:var(--secondary)}
.auth-entry .foot{width:100%;max-width:440px;text-align:center;color:var(--muted);font-size:12px;line-height:1.85}
.auth-entry .cloud-note{display:flex;justify-content:center;align-items:center;gap:7px;color:var(--secondary);margin-bottom:4px}
.auth-entry .cloud-note .icon{width:14px;height:14px;color:var(--accent)}
.auth-entry .dl{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}
.auth-entry .dl a{min-height:32px;display:inline-flex;align-items:center;gap:8px}
.auth-entry [hidden]{display:none!important}
.auth-entry button:disabled{cursor:wait;opacity:.65}
.auth-entry input:disabled{opacity:.7;cursor:wait}
.auth-entry :is(button,a,.msg):focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.auth-entry .msg:focus{outline:2px solid var(--accent);outline-offset:3px}
@keyframes night-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes night-spin{to{transform:rotate(360deg)}}
@media(min-width:1600px){.auth-entry .stage{padding-top:64px;padding-bottom:64px}.auth-entry .night-art{max-height:330px}}
@media(min-width:1024px) and (max-height:850px){.auth-entry .stage{padding-top:24px;padding-bottom:24px;gap:20px}.auth-entry .card{padding:24px 30px}.auth-entry .panel{padding-top:32px;padding-bottom:32px}.auth-entry .story{margin-top:28px}.auth-entry .night-art{max-height:220px}}
@media(max-width:1023px){.auth-entry .split{grid-template-columns:1fr}.auth-entry .panel{padding:32px 32px 0;border:0;align-items:center;text-align:center}.auth-entry .story{margin:24px 0 0}.auth-entry h1{font-size:34px}.auth-entry h1 br{display:none}.auth-entry .story-lead{font-size:14px;margin-top:8px}.auth-entry .eyebrow,.auth-entry .story-note,.auth-entry .night-art,.auth-entry .brand-foot{display:none}.auth-entry .stage{padding-top:28px}.auth-entry .brand{text-align:left}}
@media(max-width:1023px){.auth-entry .party-art{width:min(100%,360px);margin:10px auto 0}}
@media(max-width:480px){.auth-entry .panel{padding:24px 20px 0}.auth-entry .brand-name{font-size:16px}.auth-entry .brand-en{font-size:9px}.auth-entry .logo{width:40px;height:40px}.auth-entry .story{margin-top:20px}.auth-entry h1{font-size:28px;letter-spacing:.02em}.auth-entry .story-lead{max-width:260px;font-size:13px}.auth-entry .stage{padding:24px 16px max(28px,env(safe-area-inset-bottom));gap:20px}.auth-entry .card{padding:24px 20px}.auth-entry h2{font-size:24px}.auth-entry .tabs{margin-top:20px}.auth-entry .foot{font-size:12px}}
@media(prefers-reduced-motion:reduce){.auth-entry *,.auth-entry *::before,.auth-entry *::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media(forced-colors:active){.auth-entry .card,.auth-entry input,.auth-entry .tabs,.auth-entry button,.auth-entry .guestBtn,.auth-entry .msg{border:1px solid CanvasText}.auth-entry .tabs button.on{outline:2px solid Highlight;outline-offset:-3px}.auth-entry .submit{background:ButtonFace;color:ButtonText}.auth-entry :is(button,a,input,.msg):focus-visible{outline-color:Highlight}.auth-entry .night-art{display:none}}
`
