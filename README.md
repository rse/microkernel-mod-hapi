
microkernel-mod-hapi
====================

Microkernel module for integrating HAPI.

<p/>
<img src="https://nodei.co/npm/microkernel-mod-hapi.png?downloads=true&stars=true" alt=""/>

<p/>
<img src="https://david-dm.org/rse/microkernel-mod-hapi.png" alt=""/>

About
-----

This is an extension module for the
[Microkernel](http://github.com/rse/microkernel) server
application environment, adding the capability to seamlessly
integrate the HAPI framework.

Usage
-----

```shell
$ npm install microkernel
$ npm install microkernel-mod-ctx microkernel-mod-logger microkernel-mod-options
$ npm install microkernel-mod-hapi
```

```js
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
```

License
-------

Copyright (c) 2016-2019 Dr. Ralf S. Engelschall (http://engelschall.com/)

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

