# AngularJS-Server Weather Example

This example shows how AngularJS-Server can be used with a simple AngularJS application that
shows weather forecasts.

To run it (from a working AngularJS-Server development environment), use the following command:

* ``node server.js``

This will start the example server on port 3000, where you should be able to access it from your
favorite web browser. Be sure to try it both with JavaScript enabled and disabled to see the
full effect.

This example also demonstrates the more advanced "Server-Defined Routes" strategy, with the
weather data being loaded from the remote API on the server. As well as improving client-side
performance on initial page load by eliminating a round-trip, this also allows the use of
an API endpoint that wouldn't actually be callable via a cross-site XMLHttpRequest if
deferred to the client.

A very lightly modified version of this example is running as a live demo at
http://angularjs-server-weather.herokuapp.com/ .
