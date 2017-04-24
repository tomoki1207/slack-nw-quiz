var Botkit = require('botkit');
var HerokuKeepalive = require('@ponko2/botkit-heroku-keepalive');
var cheerio = require('cheerio-httpcli');
var mongoStorage = require('botkit-storage-mongo')({mongoUri: process.env.MONGODB_URI});
var cronJob = require('cron').CronJob;
var request = require('request');

if (!process.env.clientId || !process.env.clientSecret || !process.env.port) {
  console.log('Error: Specify clientId clientSecret and port in environment');
  process.exit(1);
}

var controller = Botkit.slackbot({
  storage: mongoStorage
}).configureSlackApp({
  clientId: process.env.clientId,
  clientSecret: process.env.clientSecret,
  scopes: ['bot'],
});

var herokuKeepalive;

controller.setupWebserver(process.env.port, function (err, webserver) {
  controller.createWebhookEndpoints(controller.webserver);

  controller.createOauthEndpoints(controller.webserver, function (err, req, res) {
    if (err) {
      res.status(500).send('ERROR: ' + err);
    } else {
      res.send('Success!');
    }
  });

  herokuKeepalive = new HerokuKeepalive(controller);

  // image proxy
  controller.webserver.get('/image', function (req, res) {
    console.log(req.originalUrl);
    var imageUrl = req.query.url;
    if (!imageUrl) {
      res.set('Content-Type', 'text/plain');
      res.send('Error');
      return;
    }
    request.head(imageUrl, function (err, resp, _) {
      if (err) {
        console.error(err);
        return;
      }
      res.set('Content-Type', resp.headers['content-type']);
      request(imageUrl).pipe(res);
    });
  });
});

// just a simple way to make sure we don't
// connect to the RTM twice for the same team
var _bots = {};
function trackBot(bot) {
  _bots[bot.config.token] = bot;
}

// cron
var quizCron = {};
var threeMinCron = {};

controller.on('create_bot', function (bot, config) {
  if (_bots[bot.config.token]) {
    // already online! do nothing.
  } else {
    bot.startRTM(function (err) {
      if (!err) {
        trackBot(bot);
      }
      bot.startPrivateConversation({user: config.createdBy}, function (err, convo) {
        if (err) {
          console.log(err);
        } else {
          convo.say('I am a bot that has just joined your team');
          convo.say('You must now /invite me to a channel so that I can be of use!');
        }
      });
    });
  }
});

controller.storage.teams.all(function (err, teams) {

  if (err) {
    throw new Error(err);
  }

  // connect all teams with bots up to slack!
  for (var t in teams) {
    if (teams[t].bot) {
      controller.spawn(teams[t]).startRTM(function (err, bot) {
        if (err) {
          console.log('Error connecting bot to Slack:', err);
        } else {
          trackBot(bot);
        }
      });
    }
  }
});

// Handle events related to the websocket connection to Slack
controller.on('rtm_open', function (bot) {
  console.log('** The RTM api just connected!');

  herokuKeepalive.start();

  // start cron
  console.log('** Start crons.');
  quizCron = new cronJob({
    cronTime: '0 0 9 * * 1-5',
    onTick: function () {
      generateQuiz(function (reply) {
        reply.channel = 'ipa-nw';
        bot.say(reply);
      });
    },
    start: true,
    timeZone: process.env.TZ
  });
  threeMinCron = new cronJob({
    cronTime: '0 0 13,18 * * 1-5',
    onTick: function () {
      var no = controller.storage.teams.get('articleNo') || 0;
      post3minArticle(bot, no);
      controller.storage.teams.save({id: 'articleNo', 'no': no + 1});
    },
    start: true,
    timeZone: process.env.TZ
  });
});

controller.on('rtm_close', function (bot) {
  console.log('** The RTM api just closed');
  // you may want to attempt to re-open

  // stop cron
  console.log('** Stop quiz cron.');
  if (quizCron) {
    quizCron.stop();
  }
});

controller.hears('quiz', ['direct_message', 'direct_mention'], function (bot, message) {
  generateQuiz(function (reply) {
    bot.reply(message, reply);
  });
});
controller.hears('3min', ['direct_message', 'direct_mention'], function (bot, message) {
  var no = Math.floor(Math.ramdom() * 81);
  post3minArticle(bot, no, message);
});

controller.on('interactive_message_callback', function (bot, message) {
  if (message.callback_id === 'nw_answer') {
    var collect = message.actions[0].name === 'collect';
    var text = '';
    if (collect) {
      text = ':white_check_mark: <@' + message.user + '> 正解!';
    } else {
      text = ':x: <@' + message.user + '> 残念…';
    }

    var original = message.original_message;

    bot.replyInteractive(message, {
      'text': original.text,
      'attachments': [{
        'text': text,
        'fallback': '失敗しました。',
        'callback_id': 'nw_answer',
        'color': collect ? 'good' : 'danger'
      }],
      'response_type': 'in_channel',
      'replace_original': false,
    });
  }
});

var generateQuiz = function (cb) {
  var baseUri = 'http://www.nw-siken.com/';
  cheerio.fetch(baseUri, null, function (er, $$) {
    if (er) {
      console.log('Could not access ' + baseUri);
      return;
    }

    var link = baseUri + $$('div.ansbg + div.img_margin > a').attr('href');
    cheerio.fetch(link, null, function (err, $) {
      var no = $('.qno').text();
      var q = $('.qno + div').text() + '\n\n';
      var anss = [];
      var choiseByImg = false;
      $('.selectBtn').each(function () {
        var btn = $(this);
        var ans = {
          'type': 'button',
          'name': btn.attr('id') ? 'collect' : 'wrong',
          'text': btn.find('button').text(),
          'value': btn.find('button').text()
        };

        var img = btn.prev('div').find('img');
        if (!img.length) {
          q += btn.text() + '.  ' + btn.prev('div').text() + '\n';
          anss.push(ans);
        } else {
          choiseByImg = true;
          // as other attachment
          var url = link.replace(/am2_\d+\.html/i, img.attr('src'));
          var att = {
            'text': btn.find('button').text(),
            'fallback': url,
            'image_url': process.env.HEROKU_URL + 'image?url=' + url,
            'color': '#808080',
            'callback_id': 'nw_answer',
            'actions': [ans]
          };
          anss.push(att);
        }
      });

      var attachments = [];
      attachments.push({
        'title': q,
        'text': '\n\n詳細や画像が表示されていない場合はこちらへ\n' + link,
        'fallback': q,
        'callback_id': 'db_answer',
        'color': 'good'
      });

      // show images
      $('.qno + div').find('.img_margin').each(function () {
        var d = $(this);
        var url = link.replace(/am2_\d+\.html/i, d.find('img').attr('src'));
        attachments.push({
          'text': no,
          'fallback': url,
          'color': '#808080',
          'image_url': process.env.HEROKU_URL + 'image?url=' + url,
        });
      });

      // answers
      if (choiseByImg) {
        attachments = attachments.concat(anss);
      } else {
        var a = attachments[0];
        a.actions = anss;
        attachments[0] = a;
      }

      cb({
        'text': no,
        'attachments': attachments
      });
    });
  });
};

var post3minArticle = function (bot, no, msg) {
  var padded = no === 0 ? 0 : ('00' + no).slice(-2);
  var text = {
    'text': 'まずは基礎から!\n*第 ' + no + '/81 回目* http://www5e.biglobe.ne.jp/aji/3min/' + padded + '.html'
  };
  if (msg) {
    bot.reply(msg, text);
  } else {
    text.channel = 'ipa-nw';
    bot.say(text);
  }
};