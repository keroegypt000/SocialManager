// The short address (som.<account>.workers.dev): a tiny worker that hands every request
// to the real app ("socialmanager") through a Service binding named APP.
// The request keeps its som. address, so links the app builds use the short address.
// Set up in the Cloudflare dashboard: Create Worker "som" -> paste this ->
// Settings -> Bindings -> Add -> Service binding: name APP, service socialmanager.
export default {
  fetch(request, env) {
    return env.APP.fetch(request);
  },
};
