//Imports
import cache from "memory-cache";
import generateSVG from "./plugins/isocalendar/index.js";

export default async function (req, res) {
  const { debug, cached, ...q } = Object.assign(
    {
      user: "null",
      debug: false,
      cached: true,
      cache_seconds: 3600,
      // title_color,
      // icon_color,
      // text_color,
      // bg_color,
      // theme,
      // locale,
      // border_radius,
      // border_color,
      // show_owner,
      // hide_border,
    },
    req.query
  );

  const login = req.query.user;
  console.debug("😍 => req.path:", req.path);

  //Read cached data if possible
  if (!debug && cached && cache.get(req.path)) {
    console.debug("😍 => app.get => req.path:", req.query);
    console.debug(`metrics/app/${login} > using cached image`);
    const { rendered, mime } = cache.get(req.path);
    res.header("Content-Type", mime);
    return res.send(rendered);
  }

  //Compute rendering
  try {
    //Prepare settings

    // Render
    const { rendered, mime } = await generateSVG(req);

    //Cache
    if (!debug && cached) {
      const maxage = Math.round(Number(q.cache_seconds));
      cache.put(req.path, { rendered, mime }, maxage > 0 ? maxage : cached);
    }

    //Send response
    res.header("Content-Type", mime);
    return res.send(rendered);
  } catch (error) {
    //Internal error
    //Not found user
    if (error instanceof Error && /^user not found$/.test(error.message)) {
      console.debug(`metrics/app/${login} > 404 (user/organization not found)`);
      return res.status(404).send("Not found: unknown user or organization");
    }
    //Invalid template
    if (
      error instanceof Error &&
      /^unsupported template$/.test(error.message)
    ) {
      console.debug(`metrics/app/${login} > 400 (bad request)`);
      return res.status(400).send("Bad request: unsupported template");
    }
    //Unsupported output format or account type
    if (
      error instanceof Error &&
      /^not supported for: [\s\S]*$/.test(error.message)
    ) {
      console.debug(`metrics/app/${login} > 406 (Not Acceptable)`);
      return res
        .status(406)
        .send(
          "Not Acceptable: unsupported output format or account type for specified parameters"
        );
    }
    //GitHub failed request
    if (
      error instanceof Error &&
      /this may be the result of a timeout, or it could be a GitHub bug/i.test(
        error.errors?.[0]?.message
      )
    ) {
      console.debug(`metrics/app/${login} > 502 (bad gateway from GitHub)`);
      const request = encodeURIComponent(
        error.errors[0].message.match(/`(?<request>[\w:]+)`/)?.groups
          ?.request ?? ""
      ).replace(/%3A/g, ":");
      return res
        .status(500)
        .send(
          `Internal Server Error: failed to execute request ${request} (this may be the result of a timeout, or it could be a GitHub bug)`
        );
    }
    //General error
    console.error(error);
    return res
      .status(500)
      .send("Internal Server Error: failed to process metrics correctly");
  }
}
