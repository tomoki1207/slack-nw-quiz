var Botkit = require('botkit');
var cheerio = require('cheerio-httpcli');
var s3Storage = require('./s3_storage');
var cronJob = require('cron').CronJob;

if (!process.env.clientId || !process.env.clientSecret || !process.env.port) {
  console.log('Error: Specify clientId clientSecret and port in environment');
  process.exit(1);
}

var controller = Botkit.slackbot({
  // interactive_replies: true, // tells botkit to send button clicks into conversations
  //json_file_store: './db_slackbutton_bot/',
  storage: new s3Storage({
    path: process.env.s3Path,
    bucket: process.env.s3Bucket,
    accessKey: process.env.s3AccessKey,
    secretKey: process.env.s3SecretKey
  })
}).configureSlackApp({
  clientId: process.env.clientId,
  clientSecret: process.env.clientSecret,
  scopes: ['bot'],
});

controller.setupWebserver(process.env.port, function (err, webserver) {
  controller.createWebhookEndpoints(controller.webserver);

  controller.createOauthEndpoints(controller.webserver, function (err, req, res) {
    if (err) {
      res.status(500).send('ERROR: ' + err);
    } else {
      res.send('Success!');
    }
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

  // start cron
  console.log('** Start quiz cron.');
  quizCron = new cronJob({
    cronTime: '0 0 9,13,18 * * 1-5',
    onTick: function () {
      generateQuiz(function (reply) {
        reply.channel = 'ipa-nw';
        bot.say(reply);
      });
    },
    start: true,
    timeZone: 'Asia/Tokyo'
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
  cheerio.fetch('http://www.nw-siken.com/', null, function (er, $$) {
    if (er) {
      console.log('Could not access www.nw-siken.com');
      return;
    }

    var link = 'http://www.nw-siken.com/' + $$('div.ansbg + div.img_margin > a').attr('href');
    cheerio.fetch(link, null, function (err, $) {
      var no = $('.qno').text();
      var q = $('.qno + div').text() + '\n\n';
      var anss = [];
      $('.selectBtn').each(function () {
        var btn = $(this);
        var txt = btn.prev('div');
        q += btn.text() + (txt ? ('.  ' + txt.text()) : '') + '\n';
        anss.push({
          'type': 'button',
          'name': btn.attr('id') ? 'collect' : 'wrong',
          'text': btn.find('button').text()
        });
      });

      cb({
        'text': no,
        'attachments': [{
          'title': q,
          'text': '\n\n詳細や画像が表示されていない場合はこちらへ\n' + link,
          'fallback': '失敗しました。',
          'callback_id': 'nw_answer',
          'color': '#808080',
          'actions': anss
        }]
      });
    });
  });
};