/*
**  Microkernel -- Microkernel for Server Applications
**  Copyright (c) 2015-2019 Dr. Ralf S. Engelschall <rse@engelschall.com>
**
**  Permission is hereby granted, free of charge, to any person obtaining
**  a copy of this software and associated documentation files (the
**  "Software"), to deal in the Software without restriction, including
**  without limitation the rights to use, copy, modify, merge, publish,
**  distribute, sublicense, and/or sell copies of the Software, and to
**  permit persons to whom the Software is furnished to do so, subject to
**  the following conditions:
**
**  The above copyright notice and this permission notice shall be included
**  in all copies or substantial portions of the Software.
**
**  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
**  EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
**  MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
**  IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
**  CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
**  TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
**  SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

/*  external requirements (standard)  */
const http          = require("http")

/*  external requirements (non-standard)  */
const fs            = require("mz/fs")
const HAPI          = require("@hapi/hapi")
const Auth          = require("@hapi/basic")
const HAPIDucky     = require("hapi-plugin-ducky")
const HAPITraffic   = require("hapi-plugin-traffic")
const HAPIHeader    = require("hapi-plugin-header")
const HAPIWebSocket = require("hapi-plugin-websocket")
const HAPICo        = require("hapi-plugin-co")
const HAPIAuthJWT2  = require("hapi-auth-jwt2")
const JWT           = require("jsonwebtoken")
const Inert         = require("@hapi/inert")
const Http2         = require("http2")

class Module {
    constructor (options) {
        this.options = Object.assign({
            websockets: false
        }, options || {})
    }
    get module () {
        return {
            name:  "microkernel-mod-hapi",
            tag:   "HAPI",
            group: "BASE"
        }
    }
    latch (kernel) {
        kernel.latch("options:options", (options) => {
            options.push({
                names: [ "host", "H" ], type: "string", "default": "127.0.0.1",
                help: "IP address to listen", helpArg: "ADDRESS"
            })
            options.push({
                names: [ "port", "P" ], type: "integer", "default": 8080,
                help: "TCP port to listen", helpArg: "PORT"
            })
            options.push({
                names: [ "tls" ], type: "bool", "default": false,
                help: "speak TLS on host/port"
            })
            options.push({
                names: [ "tls-key" ], type: "string", "default": null,
                help: "use private key for TLS", helpArg: "FILE"
            })
            options.push({
                names: [ "tls-cert" ], type: "string", "default": null,
                help: "use X.509 certificate for TLS", helpArg: "FILE"
            })
            options.push({
                names: [ "accounting" ], type: "bool", "default": false,
                help: "perform network traffic accounting"
            })
            options.push({
                names: [ "jwt-secret" ], type: "string", "default": "",
                help: "use secret for JSON Web Tokens (JWT)", helpArg: "SECRET"
            })
        })
    }
    async prepare (kernel) {
        /*  we operate only in standalone and worker mode  */
        if (!kernel.rs("ctx:procmode").match(/^(?:standalone|worker)$/))
            return

        /*  create underlying HTTP/HTTPS listener  */
        let listener
        if (kernel.rs("options:options").tls) {
            const key = await fs.readFile(kernel.rs("options:options").tls_key,  "utf8")
            const crt = await fs.readFile(kernel.rs("options:options").tls_cert, "utf8")
            listener = Http2.createServer({ key: key, cert: crt })
        }
        else
            listener = http.createServer()
        if (!listener.address)
            listener.address = function () { return this._server.address() }

        /*  configure the listening socket  */
        const hapiOpts = {
            listener: listener,
            address:  kernel.rs("options:options").host,
            port:     kernel.rs("options:options").port
        }
        if (kernel.rs("options:options").tls)
            hapiOpts.tls = true

        /*  establish a new server context  */
        const server = new HAPI.Server(hapiOpts)
        kernel.rs("hapi", server)

        /*  register HAPI plugins  */
        await server.register({ plugin: Inert })
        await server.register({ plugin: Auth })
        await server.register({ plugin: HAPIDucky })
        const id = kernel.rs("ctx:info").app.replace(/\s+/g, "/")
        await server.register({ plugin: HAPIHeader, options: { Server: id } })
        if (this.options.websockets)
            await server.register({ plugin: HAPIWebSocket })
        await server.register({ plugin: HAPICo })
        if (kernel.rs("options:options").accounting)
            await server.register({ plugin: HAPITraffic })

        /*  provide client IP address  */
        server.ext("onRequest", async (request, h) => {
            let clientAddress = "<unknown>"
            if (request.headers["x-forwarded-for"])
                clientAddress = request.headers["x-forwarded-for"]
                    .replace(/^(\S+)(?:,\s*\S+)*$/, "$1")
            else
                clientAddress = request.info.remoteAddress
            request.app.clientAddress = clientAddress
            return h.continue
        })

        /*  prepare for JSONWebToken (JWT) authentication  */
        const jwtKey = kernel.rs("options:options").jwt_secret
        await server.register({ plugin: HAPIAuthJWT2 })
        server.auth.strategy("jwt", "jwt", {
            key:           jwtKey,
            verifyOptions: { algorithms: [ "HS256" ] },
            urlKey:        "token",
            cookieKey:     "token",
            tokenType:     "JWT",
            validate: (decoded, request, h) => {
                const result = kernel.hook("hapi:jwt-validate", "pass",
                    { error: null, result: true }, decoded, request)
                return { isValid: result.result, error: result.error }
            }
        })
        kernel.register("hapi:jwt-sign", (data, expires) => {
            return JWT.sign(data, jwtKey, { algorithm: "HS256", expiresIn: expires || "365d" })
        })

        /*  log all requests  */
        server.events.on("response", (request) => {
            const traffic = kernel.rs("options:options").accounting ? request.traffic() : null
            let protocol = `HTTP/${request.raw.req.httpVersion}`
            if (this.options.websockets) {
                const ws = request.websocket()
                if (ws.mode === "websocket")
                    protocol = `WebSocket/${ws.ws.protocolVersion}+`
            }
            const msg =
                "request: " +
                "remote="   + `${request.app.clientAddress}:${request.info.remotePort}` + ", " +
                "method="   + request.method.toUpperCase() + ", " +
                "url="      + request.url.path + ", " +
                "protocol=" + protocol + ", " +
                "response=" + (request.response ? request.response.statusCode : "<unknown>") +
                (kernel.rs("options:options").accounting ?  ", " +
                    "recv="     + traffic.recvPayload + "/" + traffic.recvRaw + ", " +
                    "sent="     + traffic.sentPayload + "/" + traffic.sentRaw + ", " +
                    "duration=" + traffic.timeDuration : "")
            const info = { request, msg }
            kernel.hook("hapi:log", "none", info)
            kernel.sv("log", "hapi", "info", info.msg)
        })
        server.events.on({ name: "request", channels: [ "error" ] }, (request, event, tags) => {
            if (event.error instanceof Error) {
                kernel.sv("log", "hapi", "error", event.error.message)
                kernel.sv("log", "hapi", "debug", event.error.stack)
            }
            else
                kernel.sv("log", "hapi", "error", event.error)
        })
        server.events.on("log", (event, tags) => {
            if (tags.error) {
                if (event.error instanceof Error) {
                    kernel.sv("log", "hapi", "error", event.error.message)
                    kernel.sv("log", "hapi", "debug", event.error.stack)
                }
                else
                    kernel.sv("log", "hapi", "error", event.error)
            }
        })

        /*  display network interaction information  */
        const displayListenHint = ([ scheme, proto ]) => {
            const url = `${scheme}://${kernel.rs("options:options").host}:${kernel.rs("options:options").port}`
            kernel.sv("log", "hapi", "info", `listen on ${url} (${proto})`)
        }
        displayListenHint(kernel.rs("options:options").tls ?
            [ "https", "HTTP/{1.0,1.1,2.0} + SSL/TLS" ] :
            [ "http",  "HTTP/{1.0,1.1}" ])
        if (this.options.websockets)
            displayListenHint(kernel.rs("options:options").tls ?
                [ "wss", "WebSockets + SSL/TLS" ] :
                [ "ws",  "WebSockets" ])
    }
    async start (kernel) {
        /*  we operate only in standalone and worker mode  */
        if (!kernel.rs("ctx:procmode").match(/^(?:standalone|worker)$/))
            return

        /*  start the HAPI service  */
        await kernel.rs("hapi").start().then(() => {
            kernel.sv("log", "hapi", "info", "started HAPI service")
        }).catch((err) => {
            kernel.sv("log", "hapi", "error", `failed to start HAPI service: ${err}`)
        })
    }
    async stop (kernel) {
        /*  we operate only in standalone and worker mode  */
        if (!kernel.rs("ctx:procmode").match(/^(?:standalone|worker)$/))
            return

        /*   stop the HAPI service  */
        kernel.sv("log", "hapi", "info", "gracefully stopping HAPI service")
        await kernel.rs("hapi").stop({ timeout: 4 * 1000 })
    }
}

module.exports = Module

