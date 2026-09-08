// Only private, operator-installed code can supply trusted request context.
export async function invokeWithHook({request,route,host,config,db,loadHook}) {
  const clean={...request};delete clean.context;
  const invoke=(context={})=>host.invoke(clean,route,context);
  if(config.enableRequestHook!==true)return invoke();
  const hook=await loadHook();
  return hook.handleRequest({request:clean,route,invoke,db,crypto:host.crypto,config});
}
