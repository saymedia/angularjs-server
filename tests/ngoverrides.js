'use strict';

var path = require('path');
var angularServer = require('../lib/main.js');

exports.testNgoverrides = function (test) {
    test.expect(16);
    var server = angularServer.Server(
        {
            serverScripts: [
                path.join(__dirname, '../res/fakeangular.js')
            ]
        }
    );
    var $broadcast;
    var fakeInjector = {
        get: function () {
            return {
                $broadcast: $broadcast
            };
        }
    };
    var mw = server.wrapMiddlewareWithAngular(
        function (req, res, next, injector) {
            var sRCFactory = injector.angular.factoriesRegistered.serverRequestContext;
            test.ok(sRCFactory, 'serverRequestContext factory registered');
            var sRC = sRCFactory(fakeInjector);
            test.ok(!sRC.hasRequest(), 'context has no request initially');
            sRC.setRequest({
                url: '/the/path/to/riches.jpg?abc=123',
                headers: {
                    host: 'foo.bar.com'
                }
            });
            test.ok(sRC.hasRequest(), 'context has request after setRequest');
            test.throws(function () {
                sRC.setRequest({}, null, 'second setRequest throws');
            });
            var $location = sRC.location;
            test.equal($location.absUrl(), 'http://foo.bar.com/the/path/to/riches.jpg?abc=123',
                '$location has expected absUrl');
            test.equal($location.host(), 'foo.bar.com', '$location has expected host');
            test.deepEqual($location.search(), {abc: '123'}, '$location has expected search');
            $location.search({def: '456'});
            test.deepEqual($location.search(), {def: '456'}, '$location has expected search after set');
            $location.search('ghi', '789');
            test.deepEqual($location.search(), {def: '456', ghi: '789'},
                '$location has expected search after value set');
            test.equal($location.path(), '/the/path/to/riches.jpg', '$location has expected path');
            $broadcast = function ($event, redirectTo, oldUrl) {
                test.equal($event, '$locationChangeSuccess', 'setting path broadcasts success');
                test.equal(redirectTo, 'http://foo.bar.com/st/elsewhere?def=456&ghi=789',
                    'expected redirectTo broadcast after path set');
            };
            $location.path('/st/elsewhere');
            test.equal($location.path(), '/st/elsewhere', 'path was updated');
            test.equal($location.url(), '/st/elsewhere?def=456&ghi=789', '$location has expected url');
            $broadcast = function ($event, redirectTo, oldUrl) {
                test.equal(redirectTo, 'http://foo.bar.com/other/place?klm=789',
                    'expected redirectTo broadcast after url set');
            };
            $location.url('/other/place?klm=789');
            test.equal($location.url(), '/other/place?klm=789', '$location has expected url after set');
            test.equal($location.path(), '/other/place', '$location has expected path after set');
            test.done();
        }
    );

    var req = {};
    req.get = function () {
        return 'baz';
    };
    req.protocol = 'http';
    req.url = '/foo';

    mw(req, {}, {});
};
