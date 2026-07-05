/* gg.js — tiny analytics SDK for web games (itch.io friendly).
 *
 * Usage: add to your game's index.html BEFORE your game script:
 *   <script src="https://YOUR-ANALYTICS-HOST/gg.js" data-game="GAME_ID"></script>
 *
 * Then anywhere in your game:
 *   GG.track("level_complete", { level: 3, deaths: 1 });
 *
 * Sends session_start automatically, heartbeats every 20s (for playtime),
 * and flushes queued events with sendBeacon on page hide.
 */
(function () {
  "use strict";

  var script = document.currentScript;
  var GAME = script && script.getAttribute("data-game");
  var HOST = script ? script.src.replace(/\/gg\.js.*$/, "") : "";
  if (!GAME || !HOST) {
    console.warn("[gg] missing data-game attribute or host; analytics disabled");
    window.GG = { track: function () {} };
    return;
  }
  var ENDPOINT = HOST + "/api/collect";

  function rid() {
    var s = "";
    var a = "abcdefghijklmnopqrstuvwxyz0123456789";
    for (var i = 0; i < 21; i++) s += a[(Math.random() * 36) | 0];
    return s;
  }

  // Anonymous player id. itch.io sandboxed iframes can block storage — fall
  // back to a per-session id so tracking still works.
  var player;
  try {
    player = localStorage.getItem("gg_pid");
    if (!player) {
      player = rid();
      localStorage.setItem("gg_pid", player);
    }
  } catch (e) {
    player = rid();
  }

  var session = rid();
  var queue = [];

  function payload(events) {
    return JSON.stringify({
      game: GAME,
      session: session,
      player: player,
      meta: {
        referrer: document.referrer || location.hostname,
        screen: screen.width + "x" + screen.height,
        lang: navigator.language,
      },
      events: events,
    });
  }

  function flush(useBeacon) {
    if (!queue.length) return;
    var events = queue.splice(0, 25);
    var body = payload(events);
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
      return;
    }
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body,
      keepalive: true,
    }).catch(function () {});
  }

  window.GG = {
    track: function (name, props) {
      if (typeof name !== "string" || !name) return;
      queue.push(props ? { name: name, props: props } : { name: name });
      if (queue.length >= 10) flush(false);
    },
  };

  GG.track("session_start");
  flush(false);

  setInterval(function () {
    if (document.visibilityState !== "hidden") {
      GG.track("heartbeat");
      flush(false);
    }
  }, 20000);

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      GG.track("heartbeat");
      flush(true);
    }
  });
})();
