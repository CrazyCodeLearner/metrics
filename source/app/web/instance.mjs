//Imports
import octokit from "@octokit/graphql"
import OctokitRest from "@octokit/rest"
import axios from "axios"
import compression from "compression"
import crypto from "crypto"
import express from "express"
import ratelimit from "express-rate-limit"
import cache from "memory-cache"
import url from "url"
import util from "util"
import mocks from "../../../tests/mocks/index.mjs"
import metrics from "../metrics/index.mjs"
import presets from "../metrics/presets.mjs"
import setup from "../metrics/setup.mjs"

/**App */
export default async function({sandbox = false} = {}) {
  //Load configuration settings
  const {conf, Plugins, Templates} = await setup({sandbox})
  //Sandbox mode
  if (sandbox) {
    console.debug("metrics/app > sandbox mode is specified, enabling advanced features")
    Object.assign(conf.settings, {sandbox: true, optimize: true, cached: 0, "plugins.default": true, extras: {default: true}})
  }
  const {token, maxusers = 0, restricted = [], debug = false, cached = 30 * 60 * 1000, port = 3000, ratelimiter = null, plugins = null} = conf.settings
  const mock = sandbox || conf.settings.mocked

  //Process mocking and default plugin state
  for (const plugin of Object.keys(Plugins).filter(x => !["base", "core"].includes(x))) {
    //Initialization
    const {settings} = conf
    if (!settings.plugins[plugin])
      settings.plugins[plugin] = {}
    //Auto-enable plugin if needed
    if (conf.settings["plugins.default"])
      settings.plugins[plugin].enabled = settings.plugins[plugin].enabled ?? (console.debug(`metrics/app > auto-enabling ${plugin}`), true)
    //Mock plugins tokens if they're undefined
    if (mock) {
      const tokens = Object.entries(conf.metadata.plugins[plugin].inputs).filter(([key, value]) => (!/^plugin_/.test(key)) && (value.type === "token")).map(([key]) => key)
      for (const token of tokens) {
        if ((!settings.plugins[plugin][token]) || (mock === "force")) {
          console.debug(`metrics/app > using mocked token for ${plugin}.${token}`)
          settings.plugins[plugin][token] = "MOCKED_TOKEN"
        }
      }
    }
  }
  if (((mock) && (!conf.settings.token)) || (mock === "force")) {
    console.debug("metrics/app > using mocked token")
    conf.settings.token = "MOCKED_TOKEN"
  }
  if (debug)
    console.debug(util.inspect(conf.settings, {depth: Infinity, maxStringLength: 256}))

  //Load octokits
  const api = {graphql: octokit.graphql.defaults({headers: {authorization: `token ${token}`}, baseUrl: conf.settings.api?.graphql ?? undefined}), rest: new OctokitRest.Octokit({auth: token, baseUrl: conf.settings.api?.rest ?? undefined})}
  //Apply mocking if needed
  if (mock)
    Object.assign(api, await mocks(api))
  //Custom user octokits sessions
  const authenticated = new Map()
  const uapi = session => {
    if (!/^[a-f0-9]+$/i.test(`${session}`))
      return null
    if (authenticated.has(session)) {
      const {login, token} = authenticated.get(session)
      console.debug(`metrics/app/session/${login} > authenticated with session ${session.substring(0, 6)}, using custom octokit`)
      return {login, graphql: octokit.graphql.defaults({headers: {authorization: `token ${token}`}}), rest: new OctokitRest.Octokit({auth: token})}
    }
    else if (session) {
      console.debug(`metrics/app/session > unknown session ${session.substring(0, 6)}, using default octokit`)
    }
    return null
  }

  //Setup server
  const app = express()

  const middlewares = []

  //Cache headers middleware
  middlewares.push((req, res, next) => {
    const maxage = Math.round(Number(req.query.cache))
    if ((cached) || (maxage > 0))
      res.header("Cache-Control", `public, max-age=${Math.round((maxage > 0 ? maxage : cached) / 1000)}`)
    else
      res.header("Cache-Control", "no-store, no-cache")
    next()
  })

  const requests = {rest: {limit: 0, used: 0, remaining: 0, reset: NaN}, graphql: {limit: 0, used: 0, remaining: 0, reset: NaN}, search: {limit: 0, used: 0, remaining: 0, reset: NaN}}
  let _requests_refresh = false
  if (!conf.settings.notoken) {
    const refresh = async () => {
      try {
        const {resources} = (await api.rest.rateLimit.get()).data
        Object.assign(requests, {rest: resources.core, graphql: resources.graphql, search: resources.search})
      }
      catch {
        console.debug("metrics/app > failed to update remaining requests")
      }
    }
    await refresh()
    setInterval(refresh, 15 * 60 * 1000)
    setInterval(() => {
      if (_requests_refresh)
        refresh()
      _requests_refresh = false
    }, 15 * 1000)
  }

  //Pending requests
  const pending = new Map()

  app.get("/:login/:repository?", ...middlewares, async (req, res, next) => {
      //Request params
      const login = req.params.login?.replace(/[\n\r]/g, "")
      const repository = req.params.repository?.replace(/[\n\r]/g, "")
      let solve = null
      //Check username
      if ((login.startsWith(".")) || (login.includes("/")))
        return next()
      if (!/^[-\w]+$/i.test(login)) {
        console.debug(`metrics/app/${login} > 400 (invalid username)`)
        return res.status(400).send("Bad request: username seems invalid")
      }
      //Allowed list check
      if ((restricted.length) && (!restricted.includes(login))) {
        console.debug(`metrics/app/${login} > 403 (not in allowed users)`)
        return res.status(403).send("Forbidden: username not in allowed list")
      }
      //Prevent multiples requests
      if ((!debug) && (!mock) && (pending.has(login))) {
        console.debug(`metrics/app/${login} > awaiting pending request`)
        await pending.get(login)
      }
      else {
        pending.set(login, new Promise(_solve => solve = _solve))
      }

      //Read cached data if possible
      if ((!debug) && (cached) && (cache.get(req.path + req.query))) {
        console.debug("😍 => app.get => req.path:", req.path + req.query)
        console.debug(`metrics/app/${login} > using cached image`)
        const { rendered, mime } = cache.get(req.path + req.query)
        res.header("Content-Type", mime)
        return res.send(rendered)
      }
      //Maximum simultaneous users
      if ((maxusers) && (cache.size() + 1 > maxusers)) {
        console.debug(`metrics/app/${login} > 503 (maximum users reached)`)
        return res.status(503).send("Service Unavailable: maximum number of users reached, only cached metrics are available")
      }

      //Compute rendering
      try {
        //Prepare settings
        const q = req.query
        console.debug(`metrics/app/${login} > ${util.inspect(q, { depth: Infinity, maxStringLength: 256 })}`)
        const octokit = { ...api, ...uapi(req.headers["x-metrics-session"]) }
        let uconf = conf

        //Render
        const convert = uconf.settings.outputs.includes(q["config.output"]) ? q["config.output"] : uconf.settings.outputs[0]
        const { rendered, mime } = await metrics({ login, q }, {
          ...octokit,
          plugins,
          conf: uconf,
          die: q["plugins.errors.fatal"] ?? false,
          verify: q.verify ?? false,
          convert: convert !== "auto" ? convert : null,
        }, { Plugins, Templates })

        //Cache
        if ((!debug) && (cached)) {
          const maxage = Math.round(Number(req.query.cache))
          cache.put(req.path, { rendered, mime }, maxage > 0 ? maxage : cached)
        }
        //Send response
        res.header("Content-Type", mime)
        return res.send(rendered)
      }
      //Internal error
      catch (error) {
        //Not found user
        if ((error instanceof Error) && (/^user not found$/.test(error.message))) {
          console.debug(`metrics/app/${login} > 404 (user/organization not found)`)
          return res.status(404).send("Not found: unknown user or organization")
        }
        //Invalid template
        if ((error instanceof Error) && (/^unsupported template$/.test(error.message))) {
          console.debug(`metrics/app/${login} > 400 (bad request)`)
          return res.status(400).send("Bad request: unsupported template")
        }
        //Unsupported output format or account type
        if ((error instanceof Error) && (/^not supported for: [\s\S]*$/.test(error.message))) {
          console.debug(`metrics/app/${login} > 406 (Not Acceptable)`)
          return res.status(406).send("Not Acceptable: unsupported output format or account type for specified parameters")
        }
        //GitHub failed request
        if ((error instanceof Error) && (/this may be the result of a timeout, or it could be a GitHub bug/i.test(error.errors?.[0]?.message))) {
          console.debug(`metrics/app/${login} > 502 (bad gateway from GitHub)`)
          const request = encodeURIComponent(error.errors[0].message.match(/`(?<request>[\w:]+)`/)?.groups?.request ?? "").replace(/%3A/g, ":")
          return res.status(500).send(`Internal Server Error: failed to execute request ${request} (this may be the result of a timeout, or it could be a GitHub bug)`)
        }
        //General error
        console.error(error)
        return res.status(500).send("Internal Server Error: failed to process metrics correctly")
      }
      finally {
        //After rendering
        solve?.()
        _requests_refresh = true
      }
    })

    app.listen(3000)
}
