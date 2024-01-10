//Imports
import ejs from "ejs";
import util from "util";
import * as utils from "./utils.mjs";

//Setup
export default async function metrics(
  { login, q },
  {
    graphql,
    rest,
    plugins,
    conf,
    die = false,
    verify = false,
    convert = null,
    callbacks = null,
    warnings = [],
  },
  { Plugins, Templates }
) {
  //Compute rendering
  try {
    //Debug
    login = q.user;
    console.debug(`metrics/compute/${login} > start`);
    console.debug(util.inspect(q, { depth: Infinity, maxStringLength: 256 }));

    //Load template
    const template = "classic";

    const { image, style, fonts, views, partials } = conf.templates[template];

    const computer = Templates[template].default || Templates[template];
    console.debug(`metrics/compute/${login} > output format set to ${convert}`);

    //Initialization
    const pending = [];
    const { queries } = conf;
    const imports = {
      plugins: Plugins,
      templates: Templates,
      metadata: conf.metadata,
      ...utils,
      ...utils.formatters({ timeZone: q["config.timezone"] }),
    };

    const {
      "debug.flags": dflags,
      "experimental.features": _experimental,
      "config.order": _partials,
    } = imports.metadata.plugins.core.inputs({ account: "bypass", q });

    const extras = {
      css: imports.metadata.plugins.core.extras("extras_css", {
        ...conf.settings,
        error: false,
      })
        ? q["extras.css"] ?? ""
        : "",
      js: imports.metadata.plugins.core.extras("extras_js", {
        ...conf.settings,
        error: false,
      })
        ? q["extras.js"] ?? ""
        : "",
    };

    const data = {
      q,
      animated: true,
      large: false,
      base: {},
      config: {},
      errors: [],
      warnings,
      plugins: {},
      computed: {},
      extras,
      postscripts: [],
    };
    const experimental = new Set(_experimental);

    //Partial parts
    {
      data.partials = new Set([
        ..._partials.filter((partial) => partials.includes(partial)),
        ...partials,
      ]);
      console.debug(
        `metrics/compute/${login} > content order : ${[...data.partials]}`
      );
    }

    //Executing base plugin and compute metrics
    console.debug(`metrics/compute/${login} > compute`);
    await Plugins.base(
      {
        login,
        q,
        data,
        rest,
        graphql,
        plugins,
        queries,
        pending,
        imports,
        callbacks,
      },
      conf
    );
    await computer(
      { login, q },
      {
        conf,
        data,
        rest,
        graphql,
        plugins,
        queries,
        account: data.account,
        convert,
        template,
        callbacks,
      },
      { pending, imports }
    );
    const promised = await Promise.all(pending);

    //Check plugins errors
    const errors = [
      ...promised.filter(({ result = null }) => result?.error),
      ...data.errors,
    ];

    if (errors.length) {
      console.debug(`metrics/compute/${login} > ${errors.length} errors !`);
      if (die) throw new Error("An error occurred during rendering, dying");
      else
        console.debug(
          util.inspect(errors, { depth: Infinity, maxStringLength: 256 })
        );
    }

    //JSON output
    if (convert === "json") {
      console.debug(`metrics/compute/${login} > json output`);
      const cache = new WeakSet();
      const rendered = JSON.parse(
        JSON.stringify(data, (key, value) => {
          if (value instanceof Set || Array.isArray(value)) return [...value];
          if (value instanceof Map) return Object.fromEntries(value);
          if (typeof value === "object" && value) {
            if (cache.has(value))
              return Object.fromEntries(
                Object.entries(value).map(([k, v]) => [
                  k,
                  cache.has(v) ? "[Circular]" : v,
                ])
              );
            cache.add(value);
          }
          return value;
        })
      );
      return { rendered, mime: "application/json", errors };
    }

    //Rendering
    console.debug(`metrics/compute/${login} > render`);
    let rendered = await ejs.render(
      image,
      { ...data, s: imports.s, f: imports.format, style, fonts },
      { views, async: true }
    );

    //Additional transformations
    if (q["config.twemoji"]) rendered = await imports.svg.twemojis(rendered);
    if (q["config.gemoji"])
      rendered = await imports.svg.gemojis(rendered, { rest });
    if (q["config.octicon"]) rendered = await imports.svg.octicons(rendered);

    //Optimize rendering
    if (
      conf.settings?.optimize === true ||
      conf.settings?.optimize?.includes?.("css")
    )
      rendered = await imports.svg.optimize.css(rendered);
    if (
      conf.settings?.optimize === true ||
      conf.settings?.optimize?.includes?.("xml")
    )
      rendered = await imports.svg.optimize.xml(rendered, q);
    if (
      conf.settings?.optimize === true ||
      conf.settings?.optimize?.includes?.("svg")
    )
      rendered = await imports.svg.optimize.svg(rendered, q, experimental);

    //Resizing
    const { resized, mime } = await imports.svg.resize(rendered, {
      paddings: q["config.padding"] || conf.settings.padding,
      convert: convert === "svg" ? null : convert,
      scripts: [...data.postscripts, extras.js || null].filter((x) => x),
    });
    rendered = resized;

    //Result
    console.debug(`metrics/compute/${login} > success`);
    return { rendered, mime, errors };
  } catch (error) {
    //Internal error
    //User not found
    if (Array.isArray(error.errors) && error.errors[0].type === "NOT_FOUND")
      throw new Error("user not found");
    //Generic error
    throw error;
  }
}

//Metrics insights
metrics.insights = async function (
  { login },
  { graphql, rest, conf, callbacks },
  { Plugins, Templates }
) {
  return metrics(
    { login, q: metrics.insights.q },
    {
      graphql,
      rest,
      plugins: metrics.insights.plugins,
      conf,
      callbacks,
      convert: "json",
    },
    { Plugins, Templates }
  );
};
metrics.insights.q = {
  template: "classic",
  achievements: true,
  "achievements.threshold": "X",
  isocalendar: true,
  "isocalendar.duration": "full-year",
  languages: true,
  "languages.limit": 0,
  activity: true,
  "activity.limit": 100,
  "activity.days": 0,
  "activity.timestamps": true,
  notable: true,
  "notable.repositories": true,
  followup: true,
  "followup.sections": "repositories, user",
  introduction: true,
  topics: true,
  "topics.mode": "icons",
  "topics.limit": 0,
  stars: true,
  "stars.limit": 6,
  reactions: true,
  "reactions.details": "percentage",
  repositories: true,
  "repositories.pinned": 6,
  sponsors: true,
  calendar: true,
  "calendar.limit": 0,
};
metrics.insights.plugins = {
  achievements: { enabled: true },
  isocalendar: { enabled: true },
  languages: { enabled: true, extras: false },
  activity: { enabled: true, markdown: "extended" },
  notable: { enabled: true },
  followup: { enabled: true },
  introduction: { enabled: true },
  topics: { enabled: true },
  stars: { enabled: true },
  reactions: { enabled: true },
  repositories: { enabled: true },
  sponsors: { enabled: true },
  calendar: { enabled: true },
};

//Metrics insights static render
metrics.insights.output = async function (
  { login, imports, conf },
  { graphql, rest, Plugins, Templates }
) {
  //Server
  console.debug(`metrics/compute/${login} > insights`);
  const server = `http://localhost:${conf.settings.port}`;
  console.debug(
    `metrics/compute/${login} > insights > server on port ${conf.settings.port}`
  );

  //Data processing
  const browser = await imports.puppeteer.launch();
  const page = await browser.newPage();
  console.debug(`metrics/compute/${login} > insights > generating data`);
  const result = await metrics.insights(
    { login },
    { graphql, rest, conf },
    { Plugins, Templates }
  );
  const json = JSON.stringify(result);
  await page.goto(`${server}/insights/${login}?embed=1&localstorage=1`);
  await page.evaluate(
    async (json) => localStorage.setItem("local.metrics", json),
    json
  ); //eslint-disable-line no-undef
  await page.goto(`${server}/insights/${login}?embed=1&localstorage=1`);
  await page.waitForSelector(".container .user", { timeout: 10 * 60 * 1000 });

  //Rendering
  console.debug(`metrics/compute/${login} > insights > rendering data`);
  const rendered = `
    <html>
      <head>
        <meta charset="utf-8">
        <title>Metrics insights: ${login}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body>
        ${await page.evaluate(() => document.querySelector("main").outerHTML)}
        ${(
          await Promise.all(
            [
              ".css/style.vars.css",
              ".css/style.css",
              "insights/.statics/style.css",
            ].map((path) => utils.axios.get(`${server}/${path}`))
          )
        )
          .map(({ data: style }) => `<style>${style}</style>`)
          .join("\n")}
      </body>
    </html>`;
  await browser.close();
  return { mime: "text/html", rendered, errors: result.errors };
};
