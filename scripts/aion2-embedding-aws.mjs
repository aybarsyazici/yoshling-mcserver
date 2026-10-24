import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const validRegion = (value) => typeof value === "string" && /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(value);
const validProfile = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value && !value.startsWith("-") && !/[\u0000-\u001f\u007f]/.test(value);

/** Validate explicit flags without reading credentials or invoking the AWS CLI. */
export function embeddingArguments(argv) {
  const result = { build: false, profile: undefined, region: undefined };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--build") {
      if (result.build) throw new Error("Specify --build only once");
      result.build = true; continue;
    }
    const matched = /^(--profile|--region)(?:=(.*))?$/.exec(argument);
    if (!matched) throw new Error("Use only --build, --profile NAME and --region REGION");
    const key = matched[1].slice(2), value = matched[2] ?? argv[++index];
    if (result[key] !== undefined) throw new Error("Specify each embedding option only once");
    if (key === "profile" ? !validProfile(value) : !validRegion(value)) throw new Error(key === "profile" ? "Choose a valid AWS profile name" : "Choose a valid AWS Region");
    result[key] = value;
  }
  return result;
}

/** Resolve once, on the first cache miss. A cache-only rebuild never calls this. */
export function embeddingAwsConfiguration({ root, options, execute, environment = process.env }) {
  let pending;
  return () => pending ??= (async () => {
    const env = { ...environment, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" };
    const profile = options.profile ?? (env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE || undefined);
    if (profile !== undefined && !validProfile(profile)) throw new Error("Choose a valid AWS profile name");
    let variables = {};
    if (profile) {
      // Explicit profiles must not silently use another identity's static keys.
      for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "aws_access_key_id", "aws_secret_access_key", "aws_session_token", "aws_security_token"]) delete env[key];
      env.AWS_PROFILE = profile; delete env.AWS_DEFAULT_PROFILE;
    } else if (env.AWS_ACCESS_KEY_ID || env.AWS_SECRET_ACCESS_KEY) {
      if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error("AWS environment credentials are incomplete");
    } else {
      // Legacy local credentials remain supported, but .env is optional and is
      // never consulted when a profile or ambient static identity was selected.
      try { variables = require("dotenv").parse(await readFile(path.join(root, ".env"))); }
      catch (error) { if (error.code !== "ENOENT") throw new Error("The optional local AWS configuration could not be read"); }
      const access = variables.aws_access_key_id || variables.AWS_ACCESS_KEY_ID;
      const secret = variables.aws_secret_access_key || variables.AWS_SECRET_ACCESS_KEY;
      if (access || secret) {
        if (!access || !secret) throw new Error("Legacy AWS credentials are incomplete");
        env.AWS_ACCESS_KEY_ID = access; env.AWS_SECRET_ACCESS_KEY = secret;
        delete env.AWS_SESSION_TOKEN; delete env.AWS_SECURITY_TOKEN;
        const token = variables.aws_session_token || variables.AWS_SESSION_TOKEN;
        if (token) env.AWS_SESSION_TOKEN = token;
      }
    }
    const profileArgs = profile ? ["--profile", profile] : [];
    let region = options.region || env.AWS_REGION || env.AWS_DEFAULT_REGION || variables.aws_region || variables.AWS_REGION;
    if (!region) {
      try { region = (await execute("aws", ["configure", "get", "region", ...profileArgs], { env, encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 })).stdout.trim(); }
      catch { /* A missing configured region retains the existing default. */ }
    }
    region ||= "us-west-2";
    if (!validRegion(region)) throw new Error("Choose a valid AWS Region");
    return { env, region, profileArgs };
  })();
}
