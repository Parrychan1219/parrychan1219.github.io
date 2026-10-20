(function () {
    "use strict";

    var script = document.currentScript;
    var API = (script && script.getAttribute("data-api") || "").replace(/\/$/, "");
    // data-mount="<id>": build the chat inside that element instead of a floating launcher.
    var MOUNT = script && script.getAttribute("data-mount");
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
        tooLong: "That message is too long (500 characters max)."
    };

    var ICONS = {
        close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
        reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/></svg>',
        down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
        send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 5l7 7-7 7"/></svg>'
    };

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
            var node = el("div", "miho-message " + (role === "user" ? "miho-user" : "miho-bot"), text);
            log.appendChild(node);
            scroll();
            return node;
        }
        function note(text) {
            var node = el("div", "miho-note", text);
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

            fetch(API + "/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ lang: "en", messages: history.slice(-KEEP) }),
                credentials: "omit",
                cache: "no-store"
            }).then(function (res) {
                if (!res.ok) {
                    if (res.status === 429) { throw new Error(TEXT.limited); }
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
                        reply.textContent = answer;
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
                finish(err && own.indexOf(err.message) >= 0 ? err.message : TEXT.failed);
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
