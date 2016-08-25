/*
Storage module for bots.
Using AWS S3 storage.

Configuration:
  accessKey: s3 access key
  secretKey: s3 secret key
  bucket: target bucket
  path: path to s3 folder
  region(optional): s3 region (default: us-east-1)
*/

var aws = require('aws-sdk');
var async = require('async');

module.exports = function (config) {

  if (!config) {
    return {};
  }

  var teams_db = config.path + '/teams/';
  var users_db = config.path + '/users/';
  var channels_db = config.path + '/channels/';
  var bucket = config.bucket;

  aws.config.update({
    accessKeyId: config.accessKey,
    secretAccessKey: config.secretKey,
    region: config.region || 'us-east-1'
  });

  var objectsToList = function (cb) {
    return function (err, data) {
      if (err) {
        cb(err, data);
      } else {
        cb(err, Object.keys(data).map(function (key) {
          return data[key];
        }));
      }
    };
  };

  var s3 = new aws.S3();
  var put = function (id, data, cb) {
    var param = {
      Bucket: bucket,
      Key: id,
      Body: JSON.stringify(data)
    };
    // http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property
    s3.putObject(param, function (err, data) {
      if (err) {
        return (cb != null) ? cb(err) : err;
      }
      return (cb != null) ? cb(null, data) : data;
    });
  };
  var get = function (id, cb) {
    var param = {
      Bucket: bucket,
      Key: id
    };
    // http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#getObject-property
    s3.getObject(param, function (err, data) {
      if (err) {
        return (cb != null) ? cb(err) : err;
      }
      var obj = JSON.parse(data.Body.toString());
      return (cb != null) ? cb(null, obj) : obj;
    });
  };
  var list = function (prefix, cb) {
    var param = {
      Bucket: bucket,
      Prefix: prefix
    };
    // http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#listObjects-property
    s3.listObjects(param, function (err, data) {
      if (err) {
        return (cb != null) ? cb(err) : err;
      }

      var all = {};
      var funcs = [];
      data.Contents.forEach(function (content) {
        funcs.push((function (_key) {
          return function (callback) {
            get(_key, function (e, obj) {
              if (!e) {
                all[obj.id] = obj;
              }
              callback(e);
            });
          };
        })(content.Key));
      });

      return async.parallel(funcs, function (error, results) {
        return (cb != null) ? cb(error, all) : all;
      });
    });
  };

  // teams, users, channels と
  // それぞれに get, save, all があればStorageとして使える
  var storage = {
    teams: {
      get: function (team_id, cb) {
        get(teams_db + team_id, cb);
      },
      save: function (team_data, cb) {
        put(teams_db + team_data.id, team_data, cb);
      },
      all: function (cb) {
        list(teams_db, objectsToList(cb));
      }
    },
    users: {
      get: function (user_id, cb) {
        get(users_db + user_id, cb);
      },
      save: function (user, cb) {
        put(users_db + user.id, user, cb);
      },
      all: function (cb) {
        list(users_db, objectsToList(cb));
      }
    },
    channels: {
      get: function (channel_id, cb) {
        get(channels_db + channel_id, cb);
      },
      save: function (channel, cb) {
        put(channels_db + channel.id, channel, cb);
      },
      all: function (cb) {
        list(channels_db, objectsToList(cb));
      }
    }
  };

  return storage;
};
