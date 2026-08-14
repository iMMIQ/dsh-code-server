const STYLE_ID = 'dsh-code-server-styles'

const CSS = `
.dcs-host-docked{width:calc(100% - min(var(--dcs-dock-width),60vw));transition:width 160ms ease}
.dcs-root{position:absolute;inset:0;pointer-events:none;color:var(--dsw-alias-text-primary,#e8eaed);font-family:inherit}
.dcs-launcher,.dcs-drawer{pointer-events:auto}
.dcs-launcher{position:absolute;right:12px;bottom:12px;width:40px;height:40px;border:1px solid var(--dsw-alias-border-l2,#555);border-radius:6px;background:var(--dsw-alias-button-floating-fill,#27292d);color:inherit;cursor:pointer;font:600 11px/1 ui-monospace,SFMono-Regular,Consolas,monospace;box-shadow:0 3px 12px rgb(0 0 0/.25)}
.dcs-launcher:hover{background:var(--dsw-alias-button-floating-hover,#35383e)}
.dcs-drawer{position:absolute;top:0;right:0;height:100%;width:min(var(--dcs-width),100vw);min-width:min(420px,100vw);display:grid;grid-template-rows:40px minmax(0,1fr);background:#181818;border-left:1px solid var(--dsw-alias-border-l2,#444);box-shadow:-8px 0 24px rgb(0 0 0/.24);transform:translateX(0);visibility:visible;transition:transform 160ms ease,visibility 160ms ease}
.dcs-root[data-docked=true] .dcs-drawer{position:fixed;right:0;width:min(var(--dcs-width),60vw);box-shadow:none}
.dcs-root[data-open=false] .dcs-drawer{transform:translateX(100%);visibility:hidden}
.dcs-toolbar{display:flex;align-items:center;gap:8px;min-width:0;padding:0 8px 0 12px;background:var(--dsw-specific-sidebar-fill,#202124);border-bottom:1px solid var(--dsw-alias-border-l1,#3c4043)}
.dcs-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600;flex:1}
.dcs-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-text-secondary,#aeb3ba);max-width:50%}
.dcs-close,.dcs-mode{position:relative;width:30px;height:30px;flex:0 0 30px;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer}
.dcs-close:hover,.dcs-mode:hover{background:rgb(255 255 255/.09)}
.dcs-close:before,.dcs-close:after{content:"";position:absolute;left:8px;top:14px;width:14px;height:1.5px;background:currentColor}.dcs-close:before{transform:rotate(45deg)}.dcs-close:after{transform:rotate(-45deg)}
.dcs-mode:before{content:"";position:absolute;left:7px;top:7px;width:15px;height:15px;border:1.5px solid currentColor;border-radius:2px}
.dcs-mode:after{content:"";position:absolute;top:8.5px;bottom:8.5px;width:1.5px;background:currentColor}
.dcs-mode[data-docked=true]:after{right:10px}.dcs-mode[data-docked=false]:after{left:11px}
.dcs-body{position:relative;min-height:0;background:#1e1e1e}
.dcs-frame{display:block;width:100%;height:100%;border:0;background:#1e1e1e}
.dcs-state{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;background:#1e1e1e;color:#ccc;font-size:13px;z-index:1}
.dcs-state button{border:1px solid #666;border-radius:4px;background:#2d2d30;color:#fff;padding:6px 12px;cursor:pointer}
.dcs-resize{position:absolute;left:-5px;top:0;bottom:0;width:10px;cursor:col-resize;touch-action:none}
.dcs-resize:after{content:"";position:absolute;left:4px;top:0;bottom:0;width:1px;background:transparent}.dcs-resize:hover:after{background:#4daafc}
@media(max-width:800px){.dcs-host-docked{width:100%}.dcs-root[data-docked=true] .dcs-drawer{position:absolute;width:100vw}.dcs-drawer{min-width:100vw;width:100vw}.dcs-resize{display:none}.dcs-path{display:none}.dcs-mode{display:none}}
@media(prefers-reduced-motion:reduce){.dcs-host-docked,.dcs-drawer{transition:none}}
`

export function installStyles(): () => void {
  if (document.getElementById(STYLE_ID) !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = 'dsh-code-server'
  style.textContent = CSS
  document.head.append(style)
  return () => { style.remove() }
}
