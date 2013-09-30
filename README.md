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
