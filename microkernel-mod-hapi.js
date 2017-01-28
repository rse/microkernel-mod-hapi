/*
**  Microkernel -- Microkernel for Server Applications
**  Copyright (c) 2015-2017 Ralf S. Engelschall <rse@engelschall.com>
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
import http          from "http"

/*  external requirements (non-standard)  */
import fs            from "fs-promise"
import co            from "co"
import Promise       from "bluebird"
import HAPI          from "hapi"
import Auth          from "hapi-auth-basic"
import HAPIDucky     from "hapi-plugin-ducky"
import HAPITraffic   from "hapi-plugin-traffic"
import HAPIHeader    from "hapi-plugin-header"
import HAPIWebSocket from "hapi-plugin-websocket"
import HAPICo        from "hapi-plugin-co"
import HAPIBoom      from "hapi-boom-decorators"
import HAPIAuthJWT2  from "hapi-auth-jwt2"
import JWT           from "jsonwebtoken"
import Inert         from "inert"
import Http2         from "http2"

export default class Module {
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
                help: "IP address to listen", helpArg: "ADDRESS" })
            options.push({
                names: [ "port", "P" ], type: "integer", "default": 8080,
                help: "TCP port to listen", helpArg: "PORT" })
            options.push({
                names: [ "tls" ], type: "bool", "default": false,
                help: "speak TLS on host/port" })
            options.push({
                names: [ "tls-key" ], type: "string", "default": null,
                help: "use private key for TLS", helpArg: "FILE" })
            options.push({
                names: [ "tls-cert" ], type: "string", "default": null,
                help: "use X.509 certificate for TLS", helpArg: "FILE" })
            options.push({
                names: [ "accounting" ], type: "bool", "default": false,
                help: "perform network traffic accounting" })
            options.push({
                names: [ "jwt-secret" ], type: "string", "default": "",
                help: "use secret for JSON Web Tokens (JWT)", helpArg: "SECRET" })
        })
    }
    prepare (kernel) {
        return co(function * () {
            /*  we operate only in standalone and worker mode  */
            if (!kernel.rs("ctx:procmode").match(/^(?:standalone|worker)$/))
                return

            /*  establish a new server context  */
            let server = new HAPI.Server()
            kernel.rs("hapi", server)

            /*  create underlying HTTP/HTTPS listener  */
            let listener
            if (kernel.rs("options:options").tls) {
                let key = yield (fs.readFile(kernel.rs("options:options").tls_key,  "utf8"))
                let crt = yield (fs.readFile(kernel.rs("options:options").tls_cert, "utf8"))
                listener = Http2.createServer({ key: key, cert: crt })
            }
            else
                listener = http.createServer()
            if (!listener.address)
                listener.address = function () { return this._server.address() }

            /*  configure the listening socket  */
            let hapiOpts = {
                listener: listener,
                address:  kernel.rs("options:options").host,
                port:     kernel.rs("options:options").port
            }
            if (kernel.rs("options:options").tls)
                hapiOpts.tls = true
            server.connection(hapiOpts)

            /*  register HAPI plugins  */
            let register = Promise.promisify(server.register, { context: server })
            yield (register({ register: Inert }))
            yield (register({ register: Auth }))
            yield (register({ register: HAPIBoom }))
            yield (register({ register: HAPIDucky }))
            let id = kernel.rs("ctx:info").app.replace(/\s+/g, "/")
            yield (register({ register: HAPIHeader, options: { Server: id }}))
            if (this.options.websockets)
                yield (register({ register: HAPIWebSocket }))
            yield (register({ register: HAPICo }))
            if (kernel.rs("options:options").accounting)
                yield (register({ register: HAPITraffic }))

            /*  provide client IP address  */
            server.ext("onRequest", (request, reply) => {
                let clientAddress = "<unknown>"
                if (request.headers["x-forwarded-for"])
                    clientAddress = request.headers["x-forwarded-for"]
                        .replace(/^(?:\S+,\s*)*(\S+)$/, "$1")
                else
                    clientAddress = request.info.remoteAddress
                request.app.clientAddress = clientAddress
                return reply.continue()
            })

            /*  prepare for JSONWebToken (JWT) authentication  */
            let jwtKey = kernel.rs("options:options").jwt_secret
            server.register(HAPIAuthJWT2, (err) => {
                if (err)
                    throw new Error(err)
                server.auth.strategy("jwt", "jwt", {
                    key:           jwtKey,
                    verifyOptions: { algorithms: [ "HS256" ] },
                    urlKey:        "token",
                    cookieKey:     "token",
                    tokenType:     "JWT",
                    validateFunc: (decoded, request, callback) => {
                        let result = kernel.hook("hapi:jwt-validate", "pass",
                            { error: null, result: true }, decoded, request)
                        callback(result.error, result.result, decoded)
                    }
                })
            })
            kernel.register("hapi:jwt-sign", (data, expires) => {
                return JWT.sign(data, jwtKey, { algorithm: "HS256", expiresIn: expires || "365d" })
            })

            /*  log all requests  */
            server.on("tail", (request) => {
                let traffic = kernel.rs("options:options").accounting ? request.traffic() : null
                let ws = request.websocket()
                let protocol =
                    (ws ? `WebSocket/${ws.ws.protocolVersion}+` : "") +
                    `HTTP/${request.raw.req.httpVersion}`
                let msg =
                    "request: " +
                    "remote="   + `${request.app.clientAddress}:${request.info.remotePort}` + ", " +
                    "method="   + request.method.toUpperCase() + ", " +
                    "url="      + request.url.path + ", " +
                    "protocol=" + protocol + ", " +
                    "response=" + request.response.statusCode +
                    (kernel.rs("options:options").accounting ?  ", " +
                        "recv="     + traffic.recvPayload + "/" + traffic.recvRaw + ", " +
                        "sent="     + traffic.sentPayload + "/" + traffic.sentRaw + ", " +
                        "duration=" + traffic.timeDuration : "")
                let info = { request, msg }
                kernel.hook("hapi:log", "none", info)
                kernel.sv("log", "hapi", "info", info.msg)
            })
            server.on("request-error", (request, err) => {
                if (err instanceof Error) {
                    kernel.sv("log", "hapi", "error", err.message)
                    kernel.sv("log", "hapi", "debug", err.stack)
                }
                else
                    kernel.sv("log", "hapi", "error", err)
            })
            server.on("log", (event, tags) => {
                if (tags.error) {
                    let err = event.data
                    if (err instanceof Error) {
                        kernel.sv("log", "hapi", "error", err.message)
                        kernel.sv("log", "hapi", "debug", err.stack)
                    }
                    else
                        kernel.sv("log", "hapi", "error", err)
                }
            })

            /*  display network interaction information  */
            const displayListenHint = ([ scheme, proto ]) => {
                let url = `${scheme}://${kernel.rs("options:options").host}:${kernel.rs("options:options").port}`
                kernel.sv("log", "hapi", "info", `listen on ${url} (${proto})`)
            }
            displayListenHint(kernel.rs("options:options").tls ?
                [ "https", "HTTP/{1.0,1.1,2.0} + SSL/TLS" ] :
                [ "http",  "HTTP/{1.0,1.1}" ])
            displayListenHint(kernel.rs("options:options").tls ?
                [ "wss", "WebSockets + SSL/TLS" ] :
                [ "ws",  "WebSockets" ])
        }.bind(this))
    }
    start (kernel) {
        /*  we operate only in standalone and worker mode  */
        if (!kernel.rs("ctx:procmode").match(/^(?:standalone|worker)$/))
            return

        /*  start the HAPI service  */
        return new Promise((resolve, reject) => {
            kernel.rs("hapi").start((err) => {
                if (err) {
                    kernel.sv("fatal", "failed to start HAPI service")
                    reject(err)
                }
                else {
                    kernel.sv("log", "hapi", "info", "started HAPI service")
                    resolve()
                }
            })
        })
    }
    stop (kernel) {
        /*  we operate only in standalone and worker mode  */
        if (!kernel.rs("ctx:procmode").match(/^(?:standalone|worker)$/))
            return

        /*   stop the HAPI service  */
        return new Promise((resolve /*, reject */) => {
            kernel.sv("log", "hapi", "info", "gracefully stopping HAPI service")
            kernel.rs("hapi").root.stop({ timeout: 4 * 1000 }, () => {
                resolve()
            })
        })
    }
}

