
const path = require("path")
const Microkernel = require("microkernel")

const kernel = new Microkernel()

kernel.load("microkernel-mod-ctx")
kernel.load("microkernel-mod-options")
kernel.load("microkernel-mod-logger")
kernel.load([ path.join(__dirname, "microkernel-mod-hapi.js"), { websockets: true } ])

kernel.add(class ExampleModule {
    get module () {
        return {
            name:  "example",
            after: [ "HAPI" ]
        }
    }
    latch (mk) {
        let uidir = path.join(mk.rs("ctx:basedir"), ".")
        mk.latch("options:options", (options) => {
            options.push({
                names: [ "ui" ], type: "string", "default": uidir,
                help: "user interface directory", helpArg: "DIR" })
        })
    }
    prepare (mk) {
        /*  redirect top-level URL to UI  */
        mk.rs("hapi").route({
            method: "GET",
            path: "/",
            handler: (request, h) => {
                return h.redirect("ui/")
            }
        })

        /*  static delivery of the UI files  */
        mk.rs("hapi").route({
            method: "GET",
            path: "/ui/{path*}",
            handler: {
                directory: {
                    path:  mk.rs("options:options").ui,
                    index: true,
                    redirectToSlash: true
                }
            }
        })
    }
})

kernel.state("started").then(() => {
    kernel.publish("app:start:success")
}).catch((err) => {
    kernel.publish("app:start:error", err)
})

