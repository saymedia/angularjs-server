'use strict';

var path = require('path');

exports.testWrapMiddleware = function (test) {
    test.expect(13);
    var angularServer = require('../lib/main.js');

    var server = angularServer.Server(
        {
            serverScripts: [
                path.join(__dirname, '../res/fakeangular.js')
            ]
        }
    );

    test.ok(server, 'server is truthy');
    test.ok(server.wrapMiddlewareWithAngular, 'server.wrapMiddlewareWithAngular is truthy');

    var expectedReq = {};
    var expectedRes = {};
    var expectedNext = {};

    expectedReq.get = function () {
        return 'baz';
    };
    expectedReq.protocol = 'http';
    expectedReq.url = '/foo';

    var mw = server.wrapMiddlewareWithAngular(
        function (gotReq, gotRes, gotNext, gotInjector) {
            test.ok(gotReq === expectedReq, 'request passed through');
            test.ok(gotRes === expectedRes, 'response passed through');
            test.ok(gotNext === expectedNext, 'next passed through');
            test.ok(gotInjector, 'injector is truthy');

            var angular = gotInjector.angular;

            test.ok(angular, 'angular is truthy');
            test.ok(angular.fake, 'angular is fake');
            test.ok(
                angular.modulesRegistered.indexOf('angularjs-server') !== -1,
                'angularjs-server module registered'
            );

            test.ok(
                angular.modulesRegistered.indexOf('ngRoute') !== -1,
                'fake ngRoute module registered'
            );

            test.ok(
                angular.modulesRegistered.indexOf('ngAnimate') !== -1,
                'fake ngAnimate module registered'
            );

            test.ok(
                angular.requestsRegistered.length === 1,
                'nodejs request was registered exactly once'
            );
            test.ok(
                angular.requestsRegistered[0] === expectedReq,
                'the registered request is what we expected'
            );

            test.done();
        }
    );

    mw(expectedReq, expectedRes, expectedNext);

};
