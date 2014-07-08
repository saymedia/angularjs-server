
var app = angular.module('simpleapp', ['ngRoute', 'sdr']);

var cities = [
    {
        code: 'boston',
        displayName: 'Boston, MA',
        search: 'Boston,%20MA,%20US'
    },
    {
        code: 'new-york',
        displayName: 'New York, NY',
        search: 'New%20York,%20NY,%20US'
    },
    {
        code: 'portland',
        displayName: 'Portland, OR',
        search: 'Portland,%20OR,%20US'
    },
    {
        code: 'san-francisco',
        displayName: 'San Francisco, CA',
        search: 'San%20Francisco%20,%20CA,%20US'
    },
    {
        code: 'seattle',
        displayName: 'Seattle, WA',
        search: 'Seattle,%20WA,%20US'
    }
];

app.controller(
    'weatherController',
    function weatherController(weatherData, $scope) {
        $scope.city = weatherData;
        if (weatherData.main) {
            weatherData.main.tempC = Math.round(weatherData.main.temp - 273.15);
        }
        if (weatherData.weather) {
            $scope.weather = weatherData.weather[0];
        }
    }
);

app.controller(
    'chooseCityController',
    function ($scope) {
        var rows = [];
        var columns = [];
        rows.push(columns);

        angular.forEach(
            cities,
            function (city) {
                columns.push(city);
                if (columns.length == 2) {
                    columns = [];
                    rows.push(columns);
                }
            }
        );

        $scope.cityRows = rows;
    }
);

var weatherTemplate = '<h2>Weather for {{weather.name}}</h2><pre>{{weather | json}}</pre>';

app.config(
    function ($routeProvider, $locationProvider) {

        $locationProvider.html5Mode(true);
        $routeProvider.when(
            '/',
            {
                templateUrl: '/:static/partials/choosecity.html',
                controller: 'chooseCityController'
            }
        );
        $routeProvider.when(
            '/:city',
            {
                templateUrl: '/:static/partials/weather.html',
                resolve: {
                    weatherData: function ($http, $route, $q) {
                        var cityCode = $route.current.params.city;
                        var city;
                        angular.forEach(
                            cities,
                            function (maybeCity) {
                                if (maybeCity.code == cityCode) {
                                    city = maybeCity;
                                }
                            }
                        );

                        if (! city) {
                            var defer = $q.defer();
                            defer.reject(new Error("No such city"));
                            return defer.promise;
                        }

                        var weatherUrl = 'http://api.openweathermap.org/data/2.5/weather?q=' + (
                            city.search
                        );
                        return $http.get(weatherUrl).then(function (resp) { return resp.data; });
                    }
                },
                controller: 'weatherController'
            }
        );
        $routeProvider.otherwise(
            {
                template: '<a href="/">Weather</a>'
            }
        );
    }
);
