/*
 * Turns config/deployment.json into the environment that Compose interpolates.
 *
 * The mapping is mechanical and deliberately dull: a service `yggdrasil` with a
 * key `logRetentionDays` becomes `YGGDRASIL_LOG_RETENTION_DAYS`. Nothing here
 * knows what any particular setting means, so adding one is an edit to the JSON
 * and to compose.yaml, and not to this file.
 *
 * JSON rather than the .env file Compose reads by itself, which would need none
 * of this: a .env holds only flat strings, and this shape has somewhere to put
 * per-service settings as more services join the project.
 */

export function screamingSnake(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toUpperCase();
}

/**
 * Flatten a deployment config into Compose interpolation variables.
 *
 * Values are stringified because Compose interpolation is textual: a number in
 * the JSON has to reach the file as the same digits it was written as.
 */
export function toComposeEnv(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("deployment config must be an object of services");
  }

  const env = {};

  for (const [service, settings] of Object.entries(config)) {
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
      throw new TypeError(`service "${service}" must map to an object of settings`);
    }

    for (const [key, value] of Object.entries(settings)) {
      if (value !== null && typeof value === "object") {
        throw new TypeError(
          `${service}.${key} must be a scalar, because Compose interpolates text`
        );
      }

      const name = `${screamingSnake(service)}_${screamingSnake(key)}`;

      if (Object.hasOwn(env, name)) {
        throw new Error(`${service}.${key} collides with another setting on ${name}`);
      }

      env[name] = String(value ?? "");
    }
  }

  return env;
}

/**
 * Remove YAML comments, so that a `${VAR}` written in prose is not mistaken for
 * one Compose will interpolate.
 *
 * This matters more than it sounds: compose.yaml explains its choices in
 * comments, and one of those comments mentions `${HOME}` in order to say why it
 * is not used. Compose interpolates the parsed model, by which point comments
 * are gone, so treating them as references reports a variable that can never
 * need a value.
 *
 * A comment starts at a `#` that begins a line or follows whitespace, and is not
 * inside a quoted scalar.
 */
export function stripComments(source) {
  return source
    .split("\n")
    .map((line) => {
      let inSingle = false;
      let inDouble = false;

      for (let i = 0; i < line.length; i += 1) {
        const char = line[i];

        if (char === "'" && !inDouble) inSingle = !inSingle;
        else if (char === '"' && !inSingle) inDouble = !inDouble;
        else if (char === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
          return line.slice(0, i);
        }
      }

      return line;
    })
    .join("\n");
}

/**
 * Every `${VAR}` a compose file references, with or without a default or error
 * suffix. Used to check the configuration and the template against each other,
 * which is the failure this repository is most likely to hit: a variable added
 * to one and forgotten in the other.
 */
export function referencedVariables(composeSource) {
  const names = new Set();

  for (const match of stripComments(composeSource).matchAll(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/g
  )) {
    names.add(match[1]);
  }

  return names;
}
