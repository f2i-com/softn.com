/* Prepend this guest-side JS shim before Engine.initScript(source).
 * It uses the documented ZIPP host.call(kind, args, callback) queue.
 * Register gpu.execute with an explicitly granted, tenant-scoped host handler.
 */
function gpuExecute(program, done) {
  if (typeof done !== "function") throw new TypeError("gpuExecute requires a callback");
  host.call("gpu.execute", [program], function (reply) {
    if (!reply || reply.ok !== true) {
      var failure = reply && reply.error ? reply.error : {code:"GPU",message:"GPU request failed"};
      done(failure, null);
      return;
    }
    done(null, reply.value);
  });
}
function gpuExecuteAsync(program) {
  return new Promise(function (resolve, reject) {
    gpuExecute(program, function (error, result) {
      if (error) {var e = new Error(error.message);e.code=error.code;reject(e);}
      else resolve(result);
    });
  });
}
