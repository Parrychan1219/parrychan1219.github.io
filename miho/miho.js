(function () {
    "use strict";

    var script = document.currentScript;
    var API = (script && script.getAttribute("data-api") || "").replace(/\/$/, "");
    // data-mount="<id>": build the chat inside that element instead of a floating launcher.
    var MOUNT = script && script.getAttribute("data-mount");
    // Human check before chatting: Turnstile, or self-hosted ALTCHA when Turnstile can't load.
    // data-captcha = the captcha-gate base URL, data-sitekey = the Turnstile sitekey.
    var CAPTCHA = (script && script.getAttribute("data-captcha") || "").replace(/\/$/, "");
    var SITEKEY = script && script.getAttribute("data-sitekey");
    var ALTCHA_JS = (script && script.src || "").replace(/[^\/]*$/, "") + "altcha.min.js";
    var TURNSTILE_JS = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    var PASS_STORE = "miho-pass-v1";
    var STORE = "miho-conversation-v1";
    var MAX_CHARS = 500;
    var KEEP = 8;

    var TEXT = {
        name: "Nishizumi Miho",
        subtitle: "A small 2B LLM running on my own home server. Replies take a few seconds, and it gets facts wrong sometimes.",
        greeting: "Panzer vor! Um… hi, I'm Miho. Want to talk about tanks?",
        placeholder: "Type a message…",
        send: "Send",
        open: "Open Nishizumi Miho chat",
        close: "Close chat",
        reset: "Start a new conversation",
        offline: "Miho's tank is in for repairs right now (demo offline). Try again later!",
        limited: "Um, that's a lot of questions! Let me catch my breath for a bit.",
        busy: "Everyone's talking to me at once, try again in a moment!",
        failed: "Sorry, something went wrong. Please try again.",
        tooLong: "That message is too long (500 characters max).",
        checking: "Just a quick check that you're human…",
        captcha: "Um, I couldn't check that you're human. Please reload the page and try again!"
    };

    var ICONS = {
        close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
        reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/></svg>',
        down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
        send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 5l7 7-7 7"/></svg>'
    };

    function limitedText(seconds) {
        var s = Number(seconds);
        if (!(s > 0)) { return TEXT.limited; }
        if (s <= 10) { return "Um, not so fast! Give me a few seconds."; }
        if (s < 90) { return "Um, that's a lot of questions! Let me catch my breath, try again in about a minute."; }
        return "Um, that's a lot of questions! Let me catch my breath, try again in about " +
            Math.round(s / 60) + " minutes.";
    }

    // Runs of non-Latin script (CJK, kana, Cyrillic, ...) get their own span so the
    // page can give them a font and weight that match the Latin text around them.
    var SCRIPT_RUN = /[^\u0000-\u024F\u1E00-\u1EFF\u2000-\u206F\u20A0-\u20CF\u2100-\u214F\u2190-\u21FF]+/g;
    function paint(node, text) {
        node.textContent = "";
        var last = 0;
        text.replace(SCRIPT_RUN, function (run, at) {
            if (at > last) { node.appendChild(document.createTextNode(text.slice(last, at))); }
            node.appendChild(el("span", "miho-script", run));
            last = at + run.length;
            return run;
        });
        if (last < text.length) { node.appendChild(document.createTextNode(text.slice(last))); }
        return node;
    }

    function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) { node.className = cls; }
        if (text !== undefined) { node.textContent = text; }
        return node;
    }

    function load() {
        try {
            var data = JSON.parse(window.sessionStorage.getItem(STORE) || "[]");
            return Array.isArray(data) ? data.filter(function (m) {
                return m && (m.role === "user" || m.role === "assistant") &&
                    typeof m.content === "string" &&
                    (m.sig === undefined || typeof m.sig === "string");
            }) : [];
        } catch (err) { return []; }
    }

    function save(history) {
        try { window.sessionStorage.setItem(STORE, JSON.stringify(history.slice(-40))); }
        catch (err) { /* Private browsing can disable storage. */ }
    }

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement("script");
            s.src = src;
            s.async = true;
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }

    function storedPass() {
        try {
            var p = JSON.parse(window.sessionStorage.getItem(PASS_STORE) || "null");
            if (p && typeof p.pass === "string" && p.expires * 1000 - Date.now() > 60000) { return p.pass; }
        } catch (err) { /* ignore */ }
        return null;
    }

    function dropPass() {
        try { window.sessionStorage.removeItem(PASS_STORE); } catch (err) { /* ignore */ }
    }

    // Trade a Turnstile token or an ALTCHA payload for a 30-minute pass.
    function redeem(field, value) {
        var body = {};
        body[field] = value;
        return fetch(CAPTCHA + "/pass", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            credentials: "omit",
            cache: "no-store"
        }).then(function (res) {
            if (!res.ok) { throw new Error("pass"); }
            return res.json();
        }).then(function (data) {
            try { window.sessionStorage.setItem(PASS_STORE, JSON.stringify(data)); } catch (err) { /* ignore */ }
            return data.pass;
        });
    }

    // Renders the check into `box`; resolves with a pass. Turnstile first, ALTCHA after an
    // error or when Turnstile has not answered in 10 s.
    function humanCheck(box) {
        return new Promise(function (resolve, reject) {
            var fellBack = false;
            var timer = setTimeout(altcha, 10000);
            function altcha() {
                if (fellBack) { return; }
                fellBack = true;
                clearTimeout(timer);
                box.textContent = "";
                loadScript(ALTCHA_JS).then(function () {
                    var w = document.createElement("altcha-widget");
                    w.setAttribute("challenge", CAPTCHA + "/altcha/challenge");
                    w.setAttribute("auto", "onload");
                    w.setAttribute("configuration", JSON.stringify({ hideFooter: true, hideLogo: true }));
                    w.addEventListener("verified", function (event) {
                        redeem("altcha", event.detail.payload).then(resolve, reject);
                    });
                    w.addEventListener("statechange", function (event) {
                        if (event.detail && event.detail.state === "error") { reject(new Error("altcha")); }
                    });
                    box.appendChild(w);
                }, reject);
            }
            (window.turnstile ? Promise.resolve() : loadScript(TURNSTILE_JS)).then(function () {
                if (fellBack) { return; }
                window.turnstile.render(box, {
                    sitekey: SITEKEY,
                    size: "flexible",
                    appearance: "interaction-only",
                    "before-interactive-callback": function () { clearTimeout(timer); },
                    callback: function (token) {
                        if (fellBack) { return; }
                        clearTimeout(timer);
                        redeem("turnstile", token).then(resolve, function () { altcha(); });
                    },
                    "error-callback": function () { altcha(); return true; },
                    "unsupported-callback": altcha
                });
            }).catch(altcha);
        });
    }

    function build() {
        var history = load();
        var busy = false;
        var available = false;
        var healthCheck = 0;
        var mount = MOUNT ? document.getElementById(MOUNT) : null;
        var embedded = !!mount;

        var root = el("div", embedded ? "miho-embedded" : "miho-root");
        var launcher = el("button", "miho-launcher");
        launcher.type = "button";
        launcher.setAttribute("aria-label", TEXT.open);
        launcher.setAttribute("aria-expanded", "false");
        var launcherAvatar = el("img", "miho-launcher-avatar");
        launcherAvatar.src = "miho/avatar.png";
        launcherAvatar.alt = "";
        launcherAvatar.draggable = false;
        launcher.appendChild(launcherAvatar);
        launcher.insertAdjacentHTML("beforeend", ICONS.close);

        var panel = el("section", "miho-panel");
        panel.hidden = true;
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", TEXT.name);

        var header = el("header", "miho-header");
        var avatar = el("img", "miho-avatar");
        avatar.src = "miho/avatar.png";
        avatar.alt = "";
        var heading = el("div", "miho-heading");
        heading.appendChild(el("strong", "", TEXT.name));
        heading.appendChild(el("span", "", TEXT.subtitle));
        var reset = el("button", "miho-icon-button");
        reset.type = "button";
        reset.title = TEXT.reset;
        reset.setAttribute("aria-label", TEXT.reset);
        reset.insertAdjacentHTML("beforeend", ICONS.reset);
        var close = el("button", "miho-icon-button");
        close.type = "button";
        close.title = TEXT.close;
        close.setAttribute("aria-label", TEXT.close);
        close.insertAdjacentHTML("beforeend", ICONS.down);
        header.appendChild(avatar);
        header.appendChild(heading);
        header.appendChild(reset);
        header.appendChild(close);

        var log = el("div", "miho-log");
        log.setAttribute("role", "log");
        log.setAttribute("aria-live", "polite");
        var form = el("form", "miho-form");
        var input = el("textarea", "miho-input");
        input.rows = 1;
        input.maxLength = MAX_CHARS;
        input.placeholder = TEXT.placeholder;
        input.setAttribute("aria-label", TEXT.placeholder);
        input.disabled = true;
        var send = el("button", "miho-send", TEXT.send);
        send.type = "submit";
        send.disabled = true;
        form.appendChild(input);
        form.appendChild(send);
        if (embedded) {
            reset.textContent = "New";
            reset.className = "miho-reset";
            form.appendChild(reset);
            root.appendChild(log);
            root.appendChild(form);
            mount.appendChild(root);
        } else {
            panel.appendChild(header);
            panel.appendChild(log);
            panel.appendChild(form);
            root.appendChild(panel);
            root.appendChild(launcher);
            document.body.appendChild(root);
        }

        var offlineNote = null;

        function scroll() { log.scrollTop = log.scrollHeight; }
        function bubble(role, text) {
            var node = paint(el("div", "miho-message " + (role === "user" ? "miho-user" : "miho-bot")), text);
            log.appendChild(node);
            scroll();
            return node;
        }
        function note(text) {
            var node = paint(el("div", "miho-note"), text);
            log.appendChild(node);
            scroll();
            return node;
        }
        function render() {
            log.textContent = "";
            log.appendChild(el("div", "miho-greeting", TEXT.greeting));
            history.forEach(function (m) { bubble(m.role, m.content); });
        }
        function resize() {
            input.style.height = "auto";
            input.style.height = Math.min(input.scrollHeight, 110) + "px";
            send.disabled = !available || busy || !input.value.trim();
        }
        function announce(checking) {
            root.dispatchEvent(new CustomEvent("miho:state", { bubbles: true, detail: { available: available, checking: !!checking } }));
        }
        function checkHealth() {
            var requestId = ++healthCheck;
            available = false;
            input.disabled = true;
            resize();
            announce(true);
            fetch(API + "/health", {
                method: "GET",
                credentials: "omit",
                cache: "no-store"
            }).then(function (res) {
                if (!res.ok) { throw new Error("health"); }
                if (requestId !== healthCheck) { return; }
                available = true;
                input.disabled = false;
                if (offlineNote) { offlineNote.remove(); offlineNote = null; }
                resize();
                announce();
            }).catch(function () {
                if (requestId !== healthCheck) { return; }
                available = false;
                input.disabled = true;
                resize();
                if (!offlineNote) { offlineNote = note(TEXT.offline); offlineNote.classList.add("miho-offline"); }
                announce();
            });
        }
        function setOpen(open) {
            panel.hidden = !open;
            root.classList.toggle("miho-open", open);
            launcher.setAttribute("aria-expanded", open ? "true" : "false");
            if (open) {
                checkHealth();
                scroll();
                input.focus({ preventScroll: true });
            } else {
                healthCheck++;
            }
        }
        function ask(text) {
            text = text.trim();
            if (!text || busy || !available) { return; }
            if (text.length > MAX_CHARS) { note(TEXT.tooLong); return; }

            history.push({ role: "user", content: text });
            save(history);
            bubble("user", text);
            input.value = "";
            busy = true;
            resize();
            var typing = el("div", "miho-typing", "Miho is thinking…");
            log.appendChild(typing);
            scroll();
            var reply = null;
            var answer = "";
            var sig = null;

            function getPass() {
                var p = storedPass();
                if (p || !CAPTCHA) { return Promise.resolve(p); }
                var box = el("div", "miho-check");
                var label = note(TEXT.checking);
                log.insertBefore(label, typing);
                log.insertBefore(box, typing);
                scroll();
                function tidy() { label.remove(); box.remove(); }
                return humanCheck(box).then(function (pass) { tidy(); return pass; }, function () {
                    tidy();
                    var err = new Error(TEXT.captcha);
                    err.own = true;
                    throw err;
                });
            }
            function post(pass) {
                var headers = { "Content-Type": "application/json" };
                if (pass) { headers["X-Captcha-Pass"] = pass; }
                return fetch(API + "/chat", {
                    method: "POST",
                    headers: headers,
                    body: JSON.stringify({ lang: "en", messages: history.slice(-KEEP) }),
                    credentials: "omit",
                    cache: "no-store"
                });
            }

            function finish(error) {
                if (typing.parentNode) { typing.remove(); }
                if (reply) { reply.classList.remove("miho-cursor"); }
                if (answer) {
                    history.push(sig ? { role: "assistant", content: answer, sig: sig }
                                    : { role: "assistant", content: answer });
                } else {
                    history.pop();
                    if (reply) { reply.remove(); }
                }
                save(history);
                if (error) { note(error); }
                busy = false;
                resize();
            }

            getPass().then(post).then(function (res) {
                // The pass ran out or the server forgot it: check once more, then retry.
                if (res.status === 401) {
                    dropPass();
                    return getPass().then(post);
                }
                return res;
            }).then(function (res) {
                if (!res.ok) {
                    if (res.status === 429) {
                        // The body says how long to wait; turn it into words.
                        return res.json().catch(function () { return {}; }).then(function (body) {
                            var err = new Error(limitedText(body && body.retry_after));
                            err.own = true;
                            throw err;
                        });
                    }
                    if (res.status === 503) { throw new Error(TEXT.busy); }
                    if (res.status === 413) { throw new Error(TEXT.tooLong); }
                    throw new Error(TEXT.failed);
                }
                var reader = res.body.getReader();
                var decoder = new TextDecoder();
                var buffer = "";
                function handle(event) {
                    var data;
                    try { data = JSON.parse(event); } catch (err) { return; }
                    if (Object.prototype.hasOwnProperty.call(data, "t") ||
                        Object.prototype.hasOwnProperty.call(data, "replace")) {
                        if (!reply) {
                            typing.remove();
                            reply = bubble("assistant", "");
                            reply.classList.add("miho-cursor");
                        }
                        answer = Object.prototype.hasOwnProperty.call(data, "replace")
                            ? data.replace : answer + data.t;
                        paint(reply, answer);
                        scroll();
                    }
                    if (data.done && typeof data.sig === "string") { sig = data.sig; }
                    if (data.error) { throw new Error(TEXT.failed); }
                }
                function pump() {
                    return reader.read().then(function (chunk) {
                        if (chunk.done) { return; }
                        buffer += decoder.decode(chunk.value, { stream: true });
                        var parts = buffer.split("\n\n");
                        buffer = parts.pop();
                        parts.forEach(function (part) {
                            if (part.indexOf("data: ") === 0) { handle(part.slice(6)); }
                        });
                        return pump();
                    });
                }
                return pump();
            }).then(function () {
                finish(answer ? null : TEXT.failed);
            }, function (err) {
                // Only the widget's own wording reaches the visitor, never the
                // browser's ("Failed to fetch", "Load failed").
                var own = [TEXT.limited, TEXT.busy, TEXT.tooLong];
                finish(err && (err.own || own.indexOf(err.message) >= 0) ? err.message : TEXT.failed);
            });
        }

        launcher.addEventListener("click", function () { setOpen(panel.hidden); });
        close.addEventListener("click", function () { setOpen(false); launcher.focus(); });
        reset.addEventListener("click", function () {
            if (busy) { return; }
            history = [];
            save(history);
            render();
            if (offlineNote) { offlineNote = null; }
            if (embedded) { checkHealth(); }
        });
        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && !panel.hidden) { setOpen(false); launcher.focus(); }
        });
        form.addEventListener("submit", function (event) {
            event.preventDefault();
            ask(input.value);
        });
        input.addEventListener("input", resize);
        input.addEventListener("keydown", function (event) {
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                ask(input.value);
            }
        });

        render();
        if (embedded) { checkHealth(); }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", build);
    } else {
        build();
    }
})();
