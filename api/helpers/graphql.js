import fs from "fs";
import { graphql } from "@octokit/graphql";

function graphQuery(path) {
  path += ".graphql";

  if (fs.existsSync(path)) {
    console.debug(`metrics/setup > load query [${path}]`);
    let query = fs.readFileSync(path).toString("utf-8");
    console.debug("😍 => graphQuery => query:", query);

    return {
      set: (vars = {}) => {
        for (const [key, value] of Object.entries(vars))
          query = query.replace(new RegExp(`[$]${key}`, "g"), value);

        return query;
      },
    };
  }

  throw new Error(`GraphQL: ${path} not found!`);
}

export default function (path, params) {
  const query = graphQuery(path).set(params);

  return graphql(query, {
    headers: {
      authorization:
        "token " +
        (process.env.TOKEN || "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"),
    },
  });
}
