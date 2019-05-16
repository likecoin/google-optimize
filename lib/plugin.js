import axios from 'axios'
import weightedRandom from 'weighted-random'
import { parse as parseCookie, serialize as serializeCookie } from 'cookie'

import localExperiments from '<%= options.experimentsDir %>'
const MAX_AGE = <%= options.maxAge %>
const EXTERNAL_SOURCE = '<%= options.externalExperimentsSrc %>'
const COOKIE_NAME = '<%= options.cookieName %>'
const COOKIE_DOMAIN = '<%= options.cookieDomain %>'
const USE_FETCH = <%= options.useFetch %>

export default async function (ctx, inject) {

  let experiments = localExperiments || []

  if (EXTERNAL_SOURCE) {
    const remoteExperiments = await fetchExperiments(EXTERNAL_SOURCE)
    if (remoteExperiments) experiments = experiments.concat(remoteExperiments)
  }

  // Assign experiment and variant to user
  assignExperiment(ctx, experiments)

  // Google optimize integration
  googleOptimize(ctx)

  // Inject $exp
  inject('exp', ctx.experiment)
}

async function fetchExperiments(source) {
  let experiments
  let experimentsSource = source

  const defaultPort =
    process.env.API_PORT ||
    process.env.PORT ||
    process.env.npm_package_config_nuxt_port ||
    3000

  let defaultHost =
    process.env.API_HOST ||
    process.env.HOST ||
    process.env.npm_package_config_nuxt_host ||
    'localhost'

  /* istanbul ignore if */
  if (defaultHost === '0.0.0.0') {
    defaultHost = 'localhost'
  }

  if (process.server && source[0] === '/') {
    experimentsSource = `http://${defaultHost}:${defaultPort}${source}`
  }
  try {
    let data
    if (!process.server && USE_FETCH && typeof window.fetch === 'function') {
      const response = await window.fetch(experimentsSource)
      data = await response.json()
    } else {
      ({ data } = await axios.get(experimentsSource))
    }
    if (!data || !Array.isArray(data)) {
      console.error(`google-optimize: invalid data from remote source`)
    } else {
      experiments = data
    }
  } catch (err) {
    console.error(`google-optimize: failed to fetch from remote source ${experimentsSource}`)
  }
  return experiments
}

function assignExperiment(ctx, experiments) {
  // Choose experiment and variant
  let experimentIndex = -1
  let experiment = {}
  let variantIndexes = []
  let classes = []

  // Try to restore from cookie
  const cookie = getCookie(ctx, COOKIE_NAME) || '' // experimentID.var1-var2
  try {
    const [cookieExp, cookieVars] = cookie.split('.')
    if (cookieExp.length) {
      // Try to find experiment with that id
      experimentIndex = experiments.findIndex(exp => exp.experimentID === cookie[0])

      // Variant indexes
      variantIndexes = cookieVars.split('-').map(v => parseInt(v))
    }
  } catch (err) {
    console.error(err);
  }

  // Choose one experiment
  const experimentWeights = experiments.map(exp => exp.weight === undefined ? 1 : exp.weight)
  let retries = experiments.length
  while (experimentIndex === -1 && retries-- > 0) {
    experimentIndex = weightedRandom(experimentWeights)
    experiment = experiments[experimentIndex]

    // Check if current user is eligible for experiment
    if (typeof experiment.isEligible === 'function') {
      if (!experiment.isEligible(ctx)) {
        // Try another one
        experimentWeights[experimentIndex] = 0
        experimentIndex = -1
      }
    }
  }

  if (experimentIndex !== -1) {
    // Validate variantIndexes against experiment (coming from cookie)
    variantIndexes = variantIndexes.filter(index => experiment.variants[index])

    // Choose enough variants
    const variantWeights = experiment.variants.map(variant => variant.weight === undefined ? 1 : variant.weight)
    while (variantIndexes.length < (experiment.sections || 1)) {
      const index = weightedRandom(variantWeights)
      variantWeights[index] = 0
      variantIndexes.push(index)
    }

    // Write exp cookie if changed
    const expCookie = experiment.experimentID + '.' + variantIndexes.join('-')
    if (cookie !== expCookie) {
      setCookie(ctx, COOKIE_NAME, expCookie, experiment.maxAge)
    }

    // Compute global classes to be injected
    classes = variantIndexes.map(index => 'exp-' + experiment.name + '-' + index)
  } else {
    // No active experiment
    experiment = {}
    variantIndexes = []
    classes = []
  }

  ctx.experiment = {
    $experimentIndex: experimentIndex,
    $variantIndexes: variantIndexes,
    $activeVariants: variantIndexes.map(index => experiment.variants[index]),
    $classes: classes,
    ...experiment
  }
}

function getCookie(ctx, name) {
  if (process.server && !ctx.req) {
    return
  }

  // Get and parse cookies
  const cookieStr = process.client ? document.cookie : ctx.req.headers.cookie
  const cookies = parseCookie(cookieStr || '') || {}

  return cookies[name]
}

function setCookie(ctx, name, value, maxAge = MAX_AGE) {
  const serializedCookie = serializeCookie(name, value, {
    path: '/',
    domain: COOKIE_DOMAIN || undefined,
    maxAge
  })

  if (process.client) {
    // Set in browser
    document.cookie = serializedCookie
  } else if (process.server && ctx.res) {
    // Send Set-Cookie header from server side
    const prev = ctx.res.getHeader('Set-Cookie')
    let value = serializedCookie
    if (prev) {
      value = Array.isArray(prev) ? prev.concat(serializedCookie)
        : [prev, serializedCookie]
    }
    ctx.res.setHeader('Set-Cookie', value)
  }
}

// https://developers.google.com/optimize/devguides/experiments
function googleOptimize({ experiment }) {
  if (process.server || !window.ga || !experiment || !experiment.experimentID) {
    return
  }

  const exp = experiment.experimentID + '.' + experiment.$variantIndexes.join('-')

  window.ga('set', 'exp', exp)
}
