/** Server-rendered last-resort notice; no SPA scripts or authenticated library are needed. */
export const GUEST_BANNER = `
<style id="yfe-native-notice-style">
#yfe-external-notices{position:sticky;top:0;z-index:80;max-height:35vh;overflow:auto;background:rgb(var(--ink-950,28 26 23));color:rgb(var(--ink-100,232 226 216));font:13px/1.65 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif}
#yfe-external-notices[hidden]{display:none}
.yfe-native-notice{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 14px;border-bottom:1px solid rgb(var(--amber,201 162 39) / .45)}
.yfe-native-notice .notice-text{flex:1 1 220px;min-width:0;overflow-wrap:anywhere}
.yfe-native-notice :is(a,button){color:rgb(var(--amber,201 162 39));background:transparent;border:1px solid currentColor;border-radius:6px;padding:4px 8px;min-height:32px;font:inherit;cursor:pointer;text-decoration:none}
.yfe-native-notice :is(a,button):focus-visible{outline:2px solid currentColor;outline-offset:2px}
@media(forced-colors:active){.yfe-native-notice{border-color:CanvasText}.yfe-native-notice :is(a,button){color:LinkText}}
</style>
<div id="yfe-external-notices" role="region" aria-label="运行提示">
  <section id="yfe-guest-tip" class="yfe-native-notice" role="status">
    <strong>游客模式</strong><span class="notice-text">数据仅存本机浏览器，请及时导出备份。注册账号后不会自动迁移这些资料，可先导出，再在账号中导入。</span>
    <a href="/login">注册账号</a><button type="button" aria-label="关闭游客提示" onclick="__yfeDismissGuestTip()">知道了</button>
  </section>
</div>
<script>
(function(){
  var host=document.getElementById('yfe-external-notices'),root=document.getElementById('root');
  document.body.insertBefore(host,root||document.body.firstChild);
  var measure=function(){
    host.hidden=![].some.call(host.children,function(child){return !child.hidden});
    var value=(host.hidden?0:host.getBoundingClientRect().height).toFixed(2)+'px';
    if(document.documentElement.style.getPropertyValue('--yfe-notice-height')!==value)document.documentElement.style.setProperty('--yfe-notice-height',value);
  };
  window.__YFE_NOTICE_LAYOUT__=measure;
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(measure).observe(host);
  new MutationObserver(measure).observe(document.documentElement,{attributes:true,attributeFilter:['style','class']});
  window.addEventListener('resize',measure);
  window.__yfeDismissGuestTip=function(){try{localStorage.setItem('yfe-guest-tip-off','1')}catch(e){}var tip=document.getElementById('yfe-guest-tip');if(tip)tip.remove();measure()};
  try{if(localStorage.getItem('yfe-guest-tip-off')==='1')document.getElementById('yfe-guest-tip').remove()}catch(e){}
  measure();
})();
</script>`
