/**
 * Local X fixture server for Local Runner integration tests.
 *
 * Emulates the parts of X the runner interacts with:
 * - /home            signed-in home with the AppTabBar_Profile_Link handle
 * - /login           login wall ("Log in to X")
 * - /intent/post     composer page prefilled from ?text= with tweetButton
 * - POST /i/api/graphql/<id>/CreateTweet  the page's own submit endpoint
 *
 * The fixture records every CreateTweet POST so tests can assert that INSPECT
 * never submits and that duplicate PUBLISH commands never click twice.
 *
 * Behaviors are switchable at runtime via /__mode?name=...:
 * success | reject | hang | slow | opaque | daily_limit | challenge | logged_out
 */

import http from 'node:http';

const HANDLE = 'testuser';

export function startFixtureServer() {
  const state = { mode: 'success', createTweetCalls: 0, lastBodies: [] };
  let nextTweetId = 1000;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/__mode') {
      state.mode = url.searchParams.get('name') ?? 'success';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ mode: state.mode }));
      return;
    }
    if (url.pathname === '/__state') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ createTweetCalls: state.createTweetCalls, mode: state.mode }));
      return;
    }
    if (request.method === 'POST' && /\/i\/api\/graphql\/[^/]+\/CreateTweet/i.test(url.pathname)) {
      state.createTweetCalls += 1;
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        state.lastBodies.push(Buffer.concat(chunks).toString('utf8'));
        if (state.mode === 'reject') {
          response.writeHead(403, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ errors: [{ code: 187, message: 'Status is a duplicate.' }] }));
          return;
        }
        if (state.mode === 'hang') { /* never respond */ return; }
        if (state.mode === 'slow') {
          setTimeout(() => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(tweetPayload(nextTweetId++)));
          }, 12_000);
          return;
        }
        if (state.mode === 'opaque') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: {} }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(tweetPayload(nextTweetId++)));
      });
      return;
    }
    const sessionCookie = /session=testuser/.test(request.headers.cookie ?? '');
    if (url.pathname === '/login' || !sessionCookie) {
      if (url.pathname === '/home' || url.pathname === '/' || url.pathname.startsWith('/intent')) {
        response.writeHead(302, { location: '/login' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(loginPage());
      return;
    }
    if (url.pathname === '/home') {
      if (state.mode === 'challenge') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(challengePage());
        return;
      }
      if (state.mode === 'daily_limit') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(dailyLimitPage());
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(homePage());
      return;
    }
    if (url.pathname === '/intent/post') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(intentPage(url.searchParams.get('text') ?? ''));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      resolve({ server, baseUrl, state, url: baseUrl, setMode: (name) => { state.mode = name; }, createTweetCalls: () => state.createTweetCalls });
    });
  });
}

function tweetPayload(id) {
  return { data: { create_tweet: { tweet_results: { result: { rest_id: String(id), legacy: { id_str: String(id) } } } } } };
}

function homePage() {
  return `<!doctype html><html><body>
  <nav><a data-testid="AppTabBar_Profile_Link" href="/${HANDLE}">@${HANDLE}</a></nav>
  <main data-testid="homeTimeline">Home</main>
  </body></html>`;
}

function loginPage() {
  return `<!doctype html><html><body>
  <div role="main"><h1>Log in to X</h1><input placeholder="Phone, email, or username"><button data-testid="loginButton">Log in</button></div>
  <script>
    document.querySelector('[data-testid="loginButton"]').addEventListener('click', function () {
      document.cookie = 'session=testuser; path=/; max-age=86400';
      location.href = '/home';
    });
  </script>
  </body></html>`;
}

function challengePage() {
  return `<!doctype html><html><body><div id="challenge">Verify your identity — captcha required</div></body></html>`;
}

function dailyLimitPage() {
  return `<!doctype html><html><body><div>You've reached the daily post limit. Subscribe to Premium for higher limits.</div></body></html>`;
}

function intentPage(text) {
  const encoded = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const escaped = JSON.stringify(text).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <nav><a data-testid="AppTabBar_Profile_Link" href="/${HANDLE}">@${HANDLE}</a></nav>
  <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox" aria-label="Post text">${encoded}</div>
  <button data-testid="tweetButton" aria-label="Post">Post</button>
  <div id="toast-root"></div>
  <div id="links"></div>
  <script>
    (function () {
      var composer = document.querySelector('[data-testid="tweetTextarea_0"]');
      var initial = ${escaped};
      var button = document.querySelector('[data-testid="tweetButton"]');
      var submitted = false;
      button.addEventListener('click', function () {
        if (submitted) return;
        submitted = true;
        var text = composer.innerText;
        fetch('/i/api/graphql/abc123/CreateTweet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ variables: { status: text } }) })
          .then(function (response) {
            if (!response.ok) throw new Error('rejected');
            return response.json().then(function (json) {
              var tweetId = json && json.data && json.data.create_tweet && json.data.create_tweet.tweet_results && json.data.create_tweet.tweet_results.result && json.data.create_tweet.tweet_results.result.rest_id;
              if (!tweetId) {
                document.getElementById('toast-root').innerHTML = '<div data-testid="toast" role="status" aria-live="polite">Your post was sent</div>';
                return;
              }
              composer.innerText = '';
              document.getElementById('toast-root').innerHTML = '<div data-testid="toast" role="status" aria-live="polite">Your post was sent</div>';
              var link = document.createElement('a');
              link.href = '/' + '${HANDLE}' + '/status/' + tweetId;
              link.textContent = 'View post';
              document.getElementById('links').appendChild(link);
            });
          })
          .catch(function () {
            submitted = false;
          });
      });
    })();
  </script>
  </body></html>`;
}
