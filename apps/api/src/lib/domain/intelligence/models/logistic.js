/**
 * IC8 L2-REGULARISED LOGISTIC REGRESSION (architecture §8). Deterministic.
 *
 * Newton / IRLS with a fixed iteration budget: no random initialisation, no
 * data shuffling, a fixed summation order, a Cholesky solve. The same rows in
 * the same order with the same params give bit-identical coefficients, so the
 * same snapshot + model + params give identical predictions.
 *
 * Cost per iteration is O(n * p^2) for p encoded columns; it is meant for the
 * small baselines (p up to a few hundred), not for wide sparse designs.
 *
 * The encoder is part of the artifact: categorical levels are frozen at fit
 * time (sorted), unseen levels go to __other__, missing values get their own
 * indicator, numerics are standardised with the training mean/std.
 */

export const LOGISTIC_MODEL_TYPE = "logistic_l2_irls";
export const LOGISTIC_SCHEMA_VERSION = 1;
const OTHER = "__other__";
const MISSING = "__missing__";

export class ModelFitError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelFitError";
    this.code = "MODEL_FIT";
  }
}

const isMissing = (value) => value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value));

/**
 * Freeze an encoding from training records (objects of feature values).
 * numeric: keys standardised (plus a missing indicator); categorical: keys
 * one-hot encoded over levels seen at least minCategoryCount times.
 */
export function fitEncoder(records, { numeric = [], categorical = [], minCategoryCount = 1, maxLevels = 250 } = {}) {
  const numericSpecs = numeric.map((key) => {
    let sum = 0;
    let count = 0;
    for (const record of records) {
      const value = record[key];
      if (!isMissing(value)) {
        sum += Number(value);
        count += 1;
      }
    }
    const mean = count ? sum / count : 0;
    let squares = 0;
    for (const record of records) {
      const value = record[key];
      if (!isMissing(value)) squares += (Number(value) - mean) ** 2;
    }
    const std = count > 1 ? Math.sqrt(squares / (count - 1)) : 0;
    return { key, mean, std: std > 0 ? std : 1, observed: count };
  });
  const categoricalSpecs = categorical.map((key) => {
    const counts = new Map();
    for (const record of records) {
      const value = record[key];
      if (isMissing(value)) continue;
      const level = String(value);
      counts.set(level, (counts.get(level) || 0) + 1);
    }
    const levels = [...counts.entries()]
      .filter(([, count]) => count >= minCategoryCount)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxLevels)
      .map(([level]) => level)
      .sort((a, b) => a.localeCompare(b));
    return { key, levels };
  });
  const featureNames = [];
  for (const spec of numericSpecs) featureNames.push(spec.key, `${spec.key}${MISSING}`);
  for (const spec of categoricalSpecs) {
    for (const level of spec.levels) featureNames.push(`${spec.key}=${level}`);
    featureNames.push(`${spec.key}=${OTHER}`, `${spec.key}=${MISSING}`);
  }
  return { numeric: numericSpecs, categorical: categoricalSpecs, featureNames };
}

/** Encode one record into the encoder's column order. */
export function encodeRecord(encoder, record) {
  const row = [];
  for (const spec of encoder.numeric) {
    const value = record[spec.key];
    if (isMissing(value)) row.push(0, 1);
    else row.push((Number(value) - spec.mean) / spec.std, 0);
  }
  for (const spec of encoder.categorical) {
    const value = record[spec.key];
    const level = isMissing(value) ? null : String(value);
    let matched = false;
    for (const candidate of spec.levels) {
      const hit = level !== null && candidate === level;
      row.push(hit ? 1 : 0);
      if (hit) matched = true;
    }
    row.push(level !== null && !matched ? 1 : 0, level === null ? 1 : 0);
  }
  return row;
}

function sigmoid(z) {
  const clamped = Math.max(-35, Math.min(35, z));
  return 1 / (1 + Math.exp(-clamped));
}

function choleskySolve(matrix, vector, size) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const jitter = attempt === 0 ? 0 : 1e-10 * 10 ** attempt;
    const L = new Float64Array(size * size);
    let ok = true;
    for (let i = 0; i < size && ok; i += 1) {
      for (let j = 0; j <= i; j += 1) {
        let sum = matrix[i * size + j] + (i === j ? jitter : 0);
        for (let k = 0; k < j; k += 1) sum -= L[i * size + k] * L[j * size + k];
        if (i === j) {
          if (!(sum > 0)) {
            ok = false;
            break;
          }
          L[i * size + i] = Math.sqrt(sum);
        } else {
          L[i * size + j] = sum / L[j * size + j];
        }
      }
    }
    if (!ok) continue;
    const z = new Float64Array(size);
    for (let i = 0; i < size; i += 1) {
      let sum = vector[i];
      for (let k = 0; k < i; k += 1) sum -= L[i * size + k] * z[k];
      z[i] = sum / L[i * size + i];
    }
    const x = new Float64Array(size);
    for (let i = size - 1; i >= 0; i -= 1) {
      let sum = z[i];
      for (let k = i + 1; k < size; k += 1) sum -= L[k * size + i] * x[k];
      x[i] = sum / L[i * size + i];
    }
    return x;
  }
  throw new ModelFitError("Hessian is not positive definite even with jitter");
}

/**
 * Fit on a numeric design matrix X (n x d) and 0/1 labels y.
 * The intercept is never penalised; l2 applies to the summed log-likelihood.
 */
export function fitLogisticRegression(X, y, { l2 = 1, maxIter = 100, tol = 1e-8, fitIntercept = true, sampleWeight = null } = {}) {
  const n = X.length;
  if (!n) throw new ModelFitError("no training rows");
  if (y.length !== n) throw new ModelFitError("X and y differ in length");
  const d = X[0].length;
  const offset = fitIntercept ? 1 : 0;
  const p = d + offset;
  const beta = new Float64Array(p);
  const labels = y.map((v) => (v === true || v === 1 ? 1 : 0));
  const weights = sampleWeight ? sampleWeight.map(Number) : null;
  const xi = new Float64Array(p);
  let iterations = 0;
  let converged = false;
  for (let iter = 0; iter < maxIter; iter += 1) {
    iterations = iter + 1;
    const grad = new Float64Array(p);
    const hess = new Float64Array(p * p);
    for (let i = 0; i < n; i += 1) {
      if (fitIntercept) xi[0] = 1;
      const row = X[i];
      for (let j = 0; j < d; j += 1) xi[j + offset] = row[j];
      let eta = 0;
      for (let j = 0; j < p; j += 1) eta += xi[j] * beta[j];
      const mu = sigmoid(eta);
      const sw = weights ? weights[i] : 1;
      const r = (mu - labels[i]) * sw;
      const w = Math.max(mu * (1 - mu), 1e-12) * sw;
      for (let j = 0; j < p; j += 1) {
        const xj = xi[j];
        if (xj === 0) continue;
        grad[j] += r * xj;
        const wx = w * xj;
        for (let k = 0; k <= j; k += 1) hess[j * p + k] += wx * xi[k];
      }
    }
    for (let j = 0; j < p; j += 1) {
      for (let k = 0; k < j; k += 1) hess[k * p + j] = hess[j * p + k];
    }
    for (let j = offset; j < p; j += 1) {
      grad[j] += l2 * beta[j];
      hess[j * p + j] += l2;
    }
    if (fitIntercept) hess[0] += 1e-10;
    const delta = choleskySolve(hess, grad, p);
    let maxStep = 0;
    for (let j = 0; j < p; j += 1) {
      beta[j] -= delta[j];
      maxStep = Math.max(maxStep, Math.abs(delta[j]));
    }
    if (maxStep < tol) {
      converged = true;
      break;
    }
  }
  let loss = 0;
  for (let i = 0; i < n; i += 1) {
    let eta = fitIntercept ? beta[0] : 0;
    for (let j = 0; j < d; j += 1) eta += X[i][j] * beta[j + offset];
    const mu = Math.min(1 - 1e-15, Math.max(1e-15, sigmoid(eta)));
    const sw = weights ? weights[i] : 1;
    loss -= sw * (labels[i] ? Math.log(mu) : Math.log(1 - mu));
  }
  let penalty = 0;
  for (let j = offset; j < p; j += 1) penalty += beta[j] ** 2;
  loss += (l2 / 2) * penalty;
  return {
    intercept: fitIntercept ? beta[0] : 0,
    coef: Array.from(beta.slice(offset)),
    iterations,
    converged,
    loss,
  };
}

/**
 * Fit encoder + model from feature records and return a JSON-safe artifact
 * (inline in intelligence.model_versions when it is <= 100 KB).
 */
export function trainLogisticModel(records, labels, { encoder: encoderSpec = {}, params = {} } = {}) {
  if (records.length !== labels.length) throw new ModelFitError("records and labels differ in length");
  const encoder = fitEncoder(records, encoderSpec);
  const X = records.map((record) => encodeRecord(encoder, record));
  const fit = fitLogisticRegression(X, labels, params);
  const positives = labels.reduce((sum, v) => sum + (v === true || v === 1 ? 1 : 0), 0);
  return {
    type: LOGISTIC_MODEL_TYPE,
    schema_version: LOGISTIC_SCHEMA_VERSION,
    params: { l2: 1, maxIter: 100, tol: 1e-8, fitIntercept: true, ...params, sampleWeight: params.sampleWeight ? "provided" : null },
    encoder,
    feature_names: encoder.featureNames,
    intercept: fit.intercept,
    coef: fit.coef,
    fit: { iterations: fit.iterations, converged: fit.converged, loss: fit.loss, n: records.length, positives },
  };
}

export function predictProba(model, records) {
  return records.map((record) => {
    const row = encodeRecord(model.encoder, record);
    let eta = model.intercept;
    for (let j = 0; j < row.length; j += 1) eta += row[j] * model.coef[j];
    return sigmoid(eta);
  });
}

/** Per-column contribution (coef x encoded value) for one record: explanation, not rationale text. */
export function explainPrediction(model, record, { top = 5 } = {}) {
  const row = encodeRecord(model.encoder, record);
  return row
    .map((value, j) => ({ feature: model.feature_names[j], contribution: value * model.coef[j] }))
    .filter((entry) => entry.contribution !== 0)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || a.feature.localeCompare(b.feature))
    .slice(0, top);
}
