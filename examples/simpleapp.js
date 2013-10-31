
var app = angular.module('simpleapp', ['ng', 'ngRoute']);

app.controller(
    'simpleController',
    function ($scope, $location, $http) {
        $scope.currentUrl = $location.absUrl();
    }
);

app.config(
    function ($routeProvider, $locationProvider) {
        $locationProvider.html5Mode(true);
        $routeProvider.when(
            '/weather',
            {
                template: '<h2>Weather for {{weather.name}}</h2><pre>{{weather | json}}</pre>',
                resolve: {
                    weatherData: function ($http) {
                        return $http.get(
                            'http://api.openweathermap.org/data/2.5/weather?q=San%20Francisco,%20CA,%20US'
                        );
                    }
                },
                controller: function (weatherData, $scope) {
                    $scope.weather = weatherData.data;
                }
            }
        );
        $routeProvider.otherwise(
            {
                template: '<a href="/weather">Weather</a>'
            }
        );
    }
);
