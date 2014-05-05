angularjs-server
================

This is intended to become a web server specialized for serving AngularJS sites.

It uses the `angularcontext` module to run parts of the application on the server. It's hoped that this will eventually
result in the following benefits:

- True 404 errors and 302 redirects when the first request does not map to a valid page, rather than serving the
bootstrap HTML everwhere.
- Server-side rendering of the page for the benefit of robots, while still retaining the dynamic behavior for browsers.
- Run the 'resolve' steps for routes on the server so that the page can be rendered in fewer round-trips.
- Generate XML sitemaps and RSS feeds entirely on the server but using the AngularJS app itself to do so.

This server is primarily aimed at sites where it's appropriate to cache responses for a while, since performance will
be degraded if every request needs to be processed both on the server and the client. The best configuration is to
run something like Varnish in front of this server and configure it to cache for as long as possible and to serve
stale responses until the cache is freshened in the background. This way the above benefits can be realized while
still providing fast responses to everyone.

Status
------

Parts of this codebase are currently in use in production on Say Media-run content sites like
[Bio](http://biography.com/) and [xoVain](http://www.xovain.com/). However, the interface is not finalized and will
evolve as we learn more about this problem space.

Therefore this codebase is currently shared primarily as an illustration of a possible strategy for making
AngularJS-based sites robot-friendly, rather than as a ready-to-go solution. However, at the time of writing the following
features are in use in production:

* All of the AngularJS service overrides in `ngoverrides.js`. These replace several key AngularJS services with more
  appropriate implementations for the server environment.

* The `resolveRoute` and `makeJsonFriendlyRoute` functions, which allow server-side code to match paths to routes and
  run the route "resolve" code on the server.

* The `middlewareWithAngular` function, which decorates a connect middleware with code to spin up an AngularJS context
  and pass its injector as an extra parameter.

Variants of the remaining functions are in use in the Say Media content delivery platform, but their implementation has been
modified beyond what is shown in this codebase. Once their implementations are more stable we intend to update this codebase,
at which point the interface will almost certainly change.
