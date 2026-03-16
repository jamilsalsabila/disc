'use strict';

const Path = require('path');
require('dotenv').config({ path: Path.join(process.cwd(), '.env'), quiet: true });
const Crypto = require('crypto');
const Boom = require('@hapi/boom');
const Hapi = require('@hapi/hapi');
const Jwt = require('@hapi/jwt');
const Vision = require('@hapi/vision');
const Inert = require('@hapi/inert');
const Cookie = require('@hapi/cookie');
const Handlebars = require('handlebars');
const Joi = require('joi');
const Bcrypt = require('bcryptjs');

const {
  createCandidate,
  getCandidateById,
  getInProgressCandidateByBrowserToken,
  listQuestions,
  getQuestionById,
  getNextQuestionOrder,
  createQuestion,
  updateQuestionById,
  toggleQuestionActiveById,
  deleteQuestionById,
  deleteCandidateById,
  saveSubmission,
  listCandidates,
  getAnswersForCandidate
} = require('./db');
const { OPTION_TO_DISC } = require('./questions');
const { evaluateCandidate } = require('./scoring');
const { buildExcelReport, buildPdfReport, mapRecommendationLabel } = require('./exports');

const TEST_DURATION_MINUTES = 10;
const MIN_COMPLETION_RATIO = 0.8;
const IS_PROD = process.env.NODE_ENV === 'production';
const HR_LOGIN_EMAIL = process.env.HR_LOGIN_EMAIL || 'hr@disc.local';
const HR_PASSWORD_HASH = process.env.HR_PASSWORD_HASH || '$2b$10$txN96OIJRG.tmEToCLg/qu5.f6v.2BQx0x1pC40YSJCEHKBA2N.dy'; // ChangeMe123!
const HR_JWT_SECRET = process.env.HR_JWT_SECRET || 'change-this-jwt-secret-minimum-32-chars';
const HR_JWT_TTL_SECONDS = 8 * 60 * 60;
const HR_LOGIN_MAX_ATTEMPTS = 5;
const HR_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const HR_LOGIN_LOCK_MS = 15 * 60 * 1000;
const HR_AUTH_DISABLED = String(process.env.HR_AUTH_DISABLED || '').toLowerCase() === 'true';
const ROLE_OPTIONS = [
  'Server Specialist',
  'Beverage Specialist',
  'Senior Cook'
];
const hrLoginAttempts = new Map();

Handlebars.registerHelper('eq', (a, b) => a === b);
Handlebars.registerHelper('json', (value) => JSON.stringify(value));
Handlebars.registerHelper('inc', (value) => Number(value) + 1);
Handlebars.registerHelper('mapRec', (value) => mapRecommendationLabel(value));
Handlebars.registerHelper('formatDate', (isoString) => {
  if (!isoString) {
    return '-';
  }
  const date = new Date(isoString);
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
});

function nowIso() {
  return new Date().toISOString();
}

function secondsBetween(startIso, endIso) {
  return Math.max(0, Math.floor((new Date(endIso) - new Date(startIso)) / 1000));
}

function toDiscPayload(answers) {
  return Object.fromEntries(
    Object.entries(answers).map(([qid, payload]) => [
      qid,
      { mostDisc: payload.most.disc, leastDisc: payload.least.disc }
    ])
  );
}

function buildIncompleteEvaluation(evaluation, answeredCount, totalQuestions) {
  return {
    ...evaluation,
    recommendation: 'INCOMPLETE',
    roleScores: {
      SERVER_SPECIALIST: 0,
      BEVERAGE_SPECIALIST: 0,
      SENIOR_COOK: 0
    },
    reason: `Jawaban valid hanya ${answeredCount}/${totalQuestions} nomor (< ${Math.ceil(MIN_COMPLETION_RATIO * 100)}%), sehingga hasil ditandai Incomplete dan belum dapat digunakan untuk rekomendasi role.`
  };
}

function buildAnswersFromPayload(payload, testQuestions) {
  const answers = {};
  testQuestions.forEach((question) => {
    const mostOptionCode = payload[`q_${question.id}_most`];
    const leastOptionCode = payload[`q_${question.id}_least`];
    if (
      mostOptionCode &&
      leastOptionCode &&
      mostOptionCode !== leastOptionCode &&
      OPTION_TO_DISC[mostOptionCode] &&
      OPTION_TO_DISC[leastOptionCode]
    ) {
      answers[question.id] = {
        most: {
          optionCode: mostOptionCode,
          disc: OPTION_TO_DISC[mostOptionCode]
        },
        least: {
          optionCode: leastOptionCode,
          disc: OPTION_TO_DISC[leastOptionCode]
        }
      };
    }
  });
  return answers;
}

function buildDashboardStats(candidates) {
  const roleCounter = new Map();
  let dSum = 0;
  let iSum = 0;
  let sSum = 0;
  let cSum = 0;
  let totalScored = 0;

  candidates.forEach((candidate) => {
    if (candidate.recommendation) {
      roleCounter.set(candidate.recommendation, (roleCounter.get(candidate.recommendation) || 0) + 1);
    }
    if (candidate.status !== 'in_progress') {
      dSum += candidate.disc_d || 0;
      iSum += candidate.disc_i || 0;
      sSum += candidate.disc_s || 0;
      cSum += candidate.disc_c || 0;
      totalScored += 1;
    }
  });

  return {
    roleDistribution: Array.from(roleCounter.entries()).map(([recommendation, total]) => ({ recommendation, total })),
    avgDisc: {
      avg_d: totalScored ? dSum / totalScored : 0,
      avg_i: totalScored ? iSum / totalScored : 0,
      avg_s: totalScored ? sSum / totalScored : 0,
      avg_c: totalScored ? cSum / totalScored : 0,
      total_submitted: totalScored
    }
  };
}

function getClientIp(request) {
  return request.info.remoteAddress || 'unknown';
}

function getHrAttemptEntry(ip) {
  const now = Date.now();
  const entry = hrLoginAttempts.get(ip);
  if (!entry) {
    return { count: 0, windowStart: now, blockedUntil: 0 };
  }
  if (entry.blockedUntil && entry.blockedUntil <= now) {
    return { count: 0, windowStart: now, blockedUntil: 0 };
  }
  if (now - entry.windowStart > HR_LOGIN_WINDOW_MS) {
    return { count: 0, windowStart: now, blockedUntil: 0 };
  }
  return entry;
}

function isHrLoginBlocked(ip) {
  const entry = getHrAttemptEntry(ip);
  if (entry.blockedUntil && entry.blockedUntil > Date.now()) {
    return { blocked: true, retryAfterSec: Math.ceil((entry.blockedUntil - Date.now()) / 1000) };
  }
  return { blocked: false, retryAfterSec: 0 };
}

function registerHrLoginFailure(ip) {
  const now = Date.now();
  const entry = getHrAttemptEntry(ip);
  const nextCount = entry.count + 1;
  const nextEntry = {
    count: nextCount,
    windowStart: entry.windowStart || now,
    blockedUntil: 0
  };

  if (nextCount >= HR_LOGIN_MAX_ATTEMPTS) {
    nextEntry.blockedUntil = now + HR_LOGIN_LOCK_MS;
  }

  hrLoginAttempts.set(ip, nextEntry);
}

function clearHrLoginFailures(ip) {
  hrLoginAttempts.delete(ip);
}

function secureEqualString(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    return false;
  }
  return Crypto.timingSafeEqual(bufA, bufB);
}

async function verifyHrCredentials(email, password) {
  if (!secureEqualString(email.toLowerCase(), HR_LOGIN_EMAIL.toLowerCase())) {
    return false;
  }
  if (HR_PASSWORD_HASH.startsWith('$2a$') || HR_PASSWORD_HASH.startsWith('$2b$') || HR_PASSWORD_HASH.startsWith('$2y$')) {
    return Bcrypt.compare(password, HR_PASSWORD_HASH);
  }
  return secureEqualString(password, HR_PASSWORD_HASH);
}

function extractBearerToken(request) {
  const header = request.headers.authorization;
  if (!header) {
    return null;
  }
  const match = /^Bearer\\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

function getHrTokenFromRequest(request) {
  return request.state.hr_access_token || extractBearerToken(request) || null;
}

function verifyHrJwt(token) {
  const decoded = Jwt.token.decode(token);
  Jwt.token.verify(decoded, { key: HR_JWT_SECRET, algorithm: 'HS256' });
  const payload = decoded.decoded.payload;
  if (!payload || payload.scope !== 'hr' || !payload.email) {
    throw new Error('Invalid HR token payload');
  }
  return payload;
}

async function createServer() {
  if (IS_PROD && (!process.env.HR_JWT_SECRET || process.env.HR_JWT_SECRET.length < 32)) {
    throw new Error('HR_JWT_SECRET must be set and at least 32 chars in production.');
  }
  if (IS_PROD && (!process.env.COOKIE_PASSWORD || process.env.COOKIE_PASSWORD.length < 32)) {
    throw new Error('COOKIE_PASSWORD must be set and at least 32 chars in production.');
  }

  const server = Hapi.server({
    port: process.env.PORT || 3000,
    host: '0.0.0.0',
    routes: {
      files: {
        relativeTo: Path.join(__dirname, '..', 'public')
      }
    }
  });

  await server.register([Vision, Inert, Cookie, Jwt]);

  server.state('disc_browser_token', {
    ttl: 30 * 24 * 60 * 60 * 1000,
    isSecure: IS_PROD,
    isHttpOnly: true,
    isSameSite: 'Lax',
    path: '/'
  });

  server.state('hr_access_token', {
    ttl: HR_JWT_TTL_SECONDS * 1000,
    isSecure: IS_PROD,
    isHttpOnly: true,
    isSameSite: 'Strict',
    path: '/hr'
  });

  server.ext('onPreResponse', (request, h) => {
    const response = request.response;
    if (response && response.isBoom) {
      if (
        response.output?.statusCode === 401 &&
        request.path.startsWith('/hr') &&
        !request.path.startsWith('/hr/api') &&
        request.path !== '/hr/login'
      ) {
        return h.redirect('/hr/login').takeover();
      }
      return h.continue;
    }
    const contentType = response?.headers?.['content-type'] || '';
    if (typeof contentType === 'string' && contentType.includes('text/html')) {
      response.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      response.header('Pragma', 'no-cache');
      response.header('Expires', '0');
    }
    response.header('X-Content-Type-Options', 'nosniff');
    response.header('X-Frame-Options', 'DENY');
    response.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    return h.continue;
  });

  server.auth.strategy('session', 'cookie', {
    cookie: {
      name: 'disc_candidate_session',
      password: process.env.COOKIE_PASSWORD || 'disc-cookie-password-min-32-char!',
      isSecure: IS_PROD,
      isHttpOnly: true,
      isSameSite: 'Lax',
      ttl: 24 * 60 * 60 * 1000
    },
    redirectTo: '/',
    validate: async (request, session) => {
      if (!session || !session.candidateId) {
        return { isValid: false };
      }
      const candidate = getCandidateById(session.candidateId);
      if (!candidate) {
        return { isValid: false };
      }
      return { isValid: true, credentials: { candidateId: candidate.id } };
    }
  });

  server.auth.scheme('hr-jwt-scheme', () => ({
    authenticate: (request, h) => {
      if (HR_AUTH_DISABLED) {
        return h.authenticated({
          credentials: {
            role: 'hr',
            email: 'hr-auth-disabled@local',
            jti: 'auth-disabled'
          }
        });
      }

      const token = getHrTokenFromRequest(request);
      if (!token) {
        throw Boom.unauthorized('HR login required', 'Bearer');
      }

      try {
        const payload = verifyHrJwt(token);
        return h.authenticated({
          credentials: {
            role: 'hr',
            email: payload.email,
            jti: payload.jti
          }
        });
      } catch (err) {
        throw Boom.unauthorized('Invalid or expired HR token', 'Bearer');
      }
    }
  }));

  server.auth.strategy('hr-jwt', 'hr-jwt-scheme');

  server.views({
    engines: { hbs: Handlebars },
    path: Path.join(__dirname, 'views'),
    layoutPath: Path.join(__dirname, 'views/layout'),
    layout: 'main',
    isCached: false
  });

  server.route({
    method: 'GET',
    path: '/public/{param*}',
    handler: {
      directory: {
        path: '.',
        redirectToSlash: true
      }
    }
  });

  server.route({
    method: 'GET',
    path: '/',
    options: { auth: { mode: 'try', strategy: 'session' } },
    handler: async (request, h) => {
      if (request.auth.isAuthenticated) {
        return h.redirect('/test');
      }

      const browserToken = request.state.disc_browser_token;
      if (browserToken) {
        const activeCandidate = getInProgressCandidateByBrowserToken(browserToken);
        if (activeCandidate) {
          request.cookieAuth.set({ candidateId: activeCandidate.id });
          return h.redirect('/test');
        }
      }

      if (!browserToken) {
        h.state('disc_browser_token', Crypto.randomUUID());
      }

      return h.view('identity', {
        pageTitle: 'Tes DISC Kandidat',
        roleOptions: ROLE_OPTIONS
      });
    }
  });

  server.route({
    method: 'POST',
    path: '/start',
    options: {
      auth: { mode: 'try', strategy: 'session' },
      validate: {
        payload: Joi.object({
          full_name: Joi.string().trim().min(3).required(),
          email: Joi.string().trim().email({ tlds: { allow: false } }).required(),
          whatsapp: Joi.string().trim().min(8).required(),
          selected_role: Joi.string().valid(...ROLE_OPTIONS).required()
        }),
        failAction: async (request, h, err) => {
          return h.view('identity', {
            pageTitle: 'Tes DISC Kandidat',
            roleOptions: ROLE_OPTIONS,
            errorMessage: 'Data belum lengkap atau format tidak valid.',
            values: request.payload
          }).code(400).takeover();
        }
      }
    },
    handler: async (request, h) => {
      const activeQuestions = listQuestions({ includeInactive: false });
      if (!activeQuestions.length) {
        return h.view('identity', {
          pageTitle: 'Tes DISC Kandidat',
          roleOptions: ROLE_OPTIONS,
          errorMessage: 'Tes belum tersedia. Saat ini belum ada soal aktif dari tim HR.',
          values: request.payload
        }).code(400);
      }

      let browserToken = request.state.disc_browser_token;
      if (!browserToken) {
        browserToken = Crypto.randomUUID();
        h.state('disc_browser_token', browserToken);
      }

      const activeByBrowser = getInProgressCandidateByBrowserToken(browserToken);
      if (activeByBrowser) {
        request.cookieAuth.set({ candidateId: activeByBrowser.id });
        return h.redirect('/test');
      }

      if (request.auth.isAuthenticated) {
        const activeCandidate = getCandidateById(request.auth.credentials.candidateId);
        if (activeCandidate && activeCandidate.status === 'in_progress') {
          return h.redirect('/test');
        }
        request.cookieAuth.clear();
      }

      const startedAt = nowIso();
      const deadlineAt = new Date(Date.now() + (TEST_DURATION_MINUTES * 60 * 1000)).toISOString();

      const candidateId = createCandidate({
        browserToken,
        fullName: request.payload.full_name,
        email: request.payload.email,
        whatsapp: request.payload.whatsapp,
        selectedRole: request.payload.selected_role,
        startedAt,
        deadlineAt
      });

      request.cookieAuth.set({ candidateId });
      return h.redirect('/test');
    }
  });

  server.route({
    method: 'GET',
    path: '/test',
    options: {
      auth: 'session'
    },
    handler: async (request, h) => {
      const questions = listQuestions({ includeInactive: false });
      const candidate = getCandidateById(request.auth.credentials.candidateId);
      if (!candidate) {
        request.cookieAuth.clear();
        return h.redirect('/');
      }

      if (candidate.status !== 'in_progress') {
        return h.redirect(`/thank-you?id=${candidate.id}`);
      }

      if (!questions.length) {
        request.cookieAuth.clear();
        return h.view('simple-message', {
          pageTitle: 'Tes Belum Tersedia',
          title: 'Tes Belum Tersedia',
          message: 'Belum ada soal aktif. Silakan hubungi tim HR.'
        });
      }

      const expired = new Date(candidate.deadline_at) <= new Date();
      if (expired) {
        const emptyAnswers = {};
        const evaluation = evaluateCandidate({}, candidate.selected_role);
        saveSubmission({
          candidateId: candidate.id,
          answers: emptyAnswers,
          submittedAt: nowIso(),
          durationSeconds: secondsBetween(candidate.started_at, candidate.deadline_at),
          evaluation,
          forceStatus: 'timeout_submitted'
        });
        request.cookieAuth.clear();
        return h.redirect(`/thank-you?id=${candidate.id}`);
      }

      return h.view('test', {
        pageTitle: 'Tes DISC',
        candidate,
        questions,
        deadlineAt: candidate.deadline_at,
        durationMinutes: TEST_DURATION_MINUTES
      });
    }
  });

  server.route({
    method: 'POST',
    path: '/submit',
    options: {
      auth: 'session'
    },
    handler: async (request, h) => {
      const questions = listQuestions({ includeInactive: false });
      const candidate = getCandidateById(request.auth.credentials.candidateId);
      if (!candidate) {
        request.cookieAuth.clear();
        return h.redirect('/');
      }

      if (candidate.status !== 'in_progress') {
        request.cookieAuth.clear();
        return h.redirect(`/thank-you?id=${candidate.id}`);
      }

      const submittedAt = nowIso();
      const answers = buildAnswersFromPayload(request.payload || {}, questions);
      const expired = new Date(candidate.deadline_at) <= new Date(submittedAt);
      const answeredCount = Object.keys(answers).length;
      const minimumRequired = Math.ceil(questions.length * MIN_COMPLETION_RATIO);

      // Jika waktu habis, izinkan jawaban parsial untuk menghindari loop refresh.
      // Jika masih dalam waktu, semua nomor wajib terisi Most + Least.
      if (Object.keys(answers).length !== questions.length) {
        if (expired) {
          const baseEvaluation = evaluateCandidate(toDiscPayload(answers), candidate.selected_role);
          const evaluation = answeredCount < minimumRequired
            ? buildIncompleteEvaluation(baseEvaluation, answeredCount, questions.length)
            : baseEvaluation;
          const durationTimeout = secondsBetween(candidate.started_at, candidate.deadline_at);
          saveSubmission({
            candidateId: candidate.id,
            answers,
            submittedAt,
            durationSeconds: durationTimeout,
            evaluation,
            forceStatus: 'timeout_submitted'
          });
          request.cookieAuth.clear();
          return h.redirect(`/thank-you?id=${candidate.id}`);
        }

        return h.view('test', {
          pageTitle: 'Tes DISC',
          candidate,
          questions,
          deadlineAt: candidate.deadline_at,
          durationMinutes: TEST_DURATION_MINUTES,
          errorMessage: 'Semua nomor harus diisi Most dan Least, dan tidak boleh memilih opsi yang sama.'
        }).code(400);
      }
      const evaluation = evaluateCandidate(toDiscPayload(answers), candidate.selected_role);
      const duration = secondsBetween(candidate.started_at, expired ? candidate.deadline_at : submittedAt);

      saveSubmission({
        candidateId: candidate.id,
        answers,
        submittedAt,
        durationSeconds: duration,
        evaluation,
        forceStatus: expired ? 'timeout_submitted' : 'submitted'
      });

      request.cookieAuth.clear();
      return h.redirect(`/thank-you?id=${candidate.id}`);
    }
  });

  server.route({
    method: 'GET',
    path: '/thank-you',
    handler: async (request, h) => {
      const id = Number(request.query.id);
      const candidate = id ? getCandidateById(id) : null;
      return h.view('thank-you', {
        pageTitle: 'Terima Kasih',
        candidate,
        recommendationLabel: candidate ? mapRecommendationLabel(candidate.recommendation) : null
      });
    }
  });

  server.route({
    method: 'GET',
    path: '/hr/login',
    options: {
      auth: { mode: 'try', strategy: 'hr-jwt' }
    },
    handler: async (request, h) => {
      if (HR_AUTH_DISABLED) {
        return h.redirect('/hr/dashboard');
      }
      if (request.auth.isAuthenticated) {
        return h.redirect('/hr/dashboard');
      }
      return h.view('hr-login', {
        pageTitle: 'Login HR'
      });
    }
  });

  server.route({
    method: 'GET',
    path: '/hr',
    options: {
      auth: { mode: 'try', strategy: 'hr-jwt' }
    },
    handler: async (request, h) => {
      if (HR_AUTH_DISABLED) {
        return h.redirect('/hr/dashboard');
      }
      if (request.auth.isAuthenticated) {
        return h.redirect('/hr/dashboard');
      }
      return h.redirect('/hr/login');
    }
  });

  server.route({
    method: 'GET',
    path: '/hr/questions',
    options: {
      auth: 'hr-jwt'
    },
    handler: async (request, h) => {
      const questionBank = listQuestions({ includeInactive: true });
      return h.view('hr-questions', {
        pageTitle: 'Kelola Soal DISC',
        questionBank
      });
    }
  });

  server.route({
    method: 'GET',
    path: '/hr/questions/new',
    options: {
      auth: 'hr-jwt'
    },
    handler: async (request, h) => {
      return h.view('hr-question-form', {
        pageTitle: 'Tambah Soal DISC',
        formTitle: 'Tambah Soal',
        actionUrl: '/hr/questions/new',
        mode: 'create',
        values: {
          order: getNextQuestionOrder(),
          is_active: true
        }
      });
    }
  });

  server.route({
    method: 'POST',
    path: '/hr/questions/new',
    options: {
      auth: 'hr-jwt',
      validate: {
        payload: Joi.object({
          order: Joi.number().integer().min(1).required(),
          option_a: Joi.string().trim().min(3).required(),
          option_b: Joi.string().trim().min(3).required(),
          option_c: Joi.string().trim().min(3).required(),
          option_d: Joi.string().trim().min(3).required(),
          is_active: Joi.any()
        }),
        failAction: async (request, h) => {
          return h.view('hr-question-form', {
            pageTitle: 'Tambah Soal DISC',
            formTitle: 'Tambah Soal',
            actionUrl: '/hr/questions/new',
            mode: 'create',
            errorMessage: 'Semua field opsi wajib diisi minimal 3 karakter.',
            values: request.payload
          }).code(400).takeover();
        }
      }
    },
    handler: async (request, h) => {
      createQuestion({
        order: Number(request.payload.order),
        optionA: request.payload.option_a.trim(),
        optionB: request.payload.option_b.trim(),
        optionC: request.payload.option_c.trim(),
        optionD: request.payload.option_d.trim(),
        isActive: Boolean(request.payload.is_active)
      });
      return h.redirect('/hr/questions');
    }
  });

  server.route({
    method: 'GET',
    path: '/hr/questions/{id}/edit',
    options: {
      auth: 'hr-jwt'
    },
    handler: async (request, h) => {
      const question = getQuestionById(Number(request.params.id));
      if (!question) {
        return h.response('Question not found').code(404);
      }
      return h.view('hr-question-form', {
        pageTitle: `Edit Soal #${question.id}`,
        formTitle: `Edit Soal #${question.id}`,
        actionUrl: `/hr/questions/${question.id}/edit`,
        mode: 'edit',
        values: {
          order: question.order,
          option_a: question.options.A,
          option_b: question.options.B,
          option_c: question.options.C,
          option_d: question.options.D,
          is_active: question.isActive
        }
      });
    }
  });

  server.route({
    method: 'POST',
    path: '/hr/questions/{id}/edit',
    options: {
      auth: 'hr-jwt',
      validate: {
        payload: Joi.object({
          order: Joi.number().integer().min(1).required(),
          option_a: Joi.string().trim().min(3).required(),
          option_b: Joi.string().trim().min(3).required(),
          option_c: Joi.string().trim().min(3).required(),
          option_d: Joi.string().trim().min(3).required(),
          is_active: Joi.any()
        }),
        failAction: async (request, h) => {
          return h.view('hr-question-form', {
            pageTitle: `Edit Soal #${request.params.id}`,
            formTitle: `Edit Soal #${request.params.id}`,
            actionUrl: `/hr/questions/${request.params.id}/edit`,
            mode: 'edit',
            errorMessage: 'Semua field opsi wajib diisi minimal 3 karakter.',
            values: request.payload
          }).code(400).takeover();
        }
      }
    },
    handler: async (request, h) => {
      const updated = updateQuestionById(Number(request.params.id), {
        order: Number(request.payload.order),
        optionA: request.payload.option_a.trim(),
        optionB: request.payload.option_b.trim(),
        optionC: request.payload.option_c.trim(),
        optionD: request.payload.option_d.trim(),
        isActive: Boolean(request.payload.is_active)
      });
      if (!updated) {
        return h.response('Question not found').code(404);
      }
      return h.redirect('/hr/questions');
    }
  });

  server.route({
    method: 'POST',
    path: '/hr/questions/{id}/toggle-active',
    options: {
      auth: 'hr-jwt'
    },
    handler: async (request, h) => {
      const changed = toggleQuestionActiveById(Number(request.params.id));
      if (!changed) {
        return h.response('Question not found').code(404);
      }
      return h.redirect('/hr/questions');
    }
  });

  server.route({
    method: 'POST',
    path: '/hr/questions/{id}/delete',
    options: {
      auth: 'hr-jwt'
    },
    handler: async (request, h) => {
      const deleted = deleteQuestionById(Number(request.params.id));
      if (!deleted) {
        return h.response('Question not found').code(404);
      }
      return h.redirect('/hr/questions');
    }
  });

  server.route({
    method: 'POST',
    path: '/hr/login',
    options: {
      auth: { mode: 'try', strategy: 'hr-jwt' },
      validate: {
        payload: Joi.object({
          email: Joi.string().trim().email({ tlds: { allow: false } }).required(),
          password: Joi.string().min(8).max(128).required()
        }),
        failAction: async (request, h) => {
          return h.view('hr-login', {
            pageTitle: 'Login HR',
            errorMessage: 'Format email atau password tidak valid.',
            values: {
              email: request.payload?.email || ''
            }
          }).code(400).takeover();
        }
      }
    },
    handler: async (request, h) => {
      if (request.auth.isAuthenticated) {
        return h.redirect('/hr/dashboard');
      }

      const ip = getClientIp(request);
      const blockState = isHrLoginBlocked(ip);
      if (blockState.blocked) {
        return h.view('hr-login', {
          pageTitle: 'Login HR',
          errorMessage: `Terlalu banyak percobaan login. Coba lagi dalam ${blockState.retryAfterSec} detik.`,
          values: { email: request.payload.email }
        }).code(429);
      }

      const valid = await verifyHrCredentials(request.payload.email, request.payload.password);
      if (!valid) {
        registerHrLoginFailure(ip);
        return h.view('hr-login', {
          pageTitle: 'Login HR',
          errorMessage: 'Email atau password HR salah.',
          values: { email: request.payload.email }
        }).code(401);
      }

      clearHrLoginFailures(ip);

      const token = Jwt.token.generate(
        {
          scope: 'hr',
          email: HR_LOGIN_EMAIL,
          jti: Crypto.randomUUID()
        },
        {
          key: HR_JWT_SECRET,
          algorithm: 'HS256'
        },
        {
          ttlSec: HR_JWT_TTL_SECONDS
        }
      );

      h.state('hr_access_token', token);
      return h.redirect('/hr/dashboard');
    }
  });

  server.route({
    method: 'POST',
    path: '/hr/logout',
    options: {
      auth: { mode: 'required', strategy: 'hr-jwt' }
    },
    handler: async (request, h) => {
      h.unstate('hr_access_token', { path: '/hr' });
      return h.redirect('/hr/login');
    }
  });

  server.route({
    method: 'GET',
    path: '/hr/dashboard',
    options: {
      auth: 'hr-jwt'
    },
    handler: async (request, h) => {
      const { search = '', role = '', recommendation = '' } = request.query;
      const candidates = listCandidates({ search, role, recommendation });
      const stats = buildDashboardStats(candidates);

      return h.view('hr-dashboard', {
        pageTitle: 'Dashboard HR - DISC',
        candidates,
        filters: { search, role, recommendation },
        recommendationOptions: [
          { value: 'SERVER_SPECIALIST', label: 'Server Specialist' },
          { value: 'BEVERAGE_SPECIALIST', label: 'Beverage Specialist' },
          { value: 'SENIOR_COOK', label: 'Senior Cook' },
          { value: 'INCOMPLETE', label: 'Incomplete' },
          { value: 'TIDAK_DIREKOMENDASIKAN', label: 'Tidak Direkomendasikan' }
        ],
        roleOptions: ROLE_OPTIONS,
        candidatesJson: JSON.stringify(candidates),
        roleDistributionJson: JSON.stringify(stats.roleDistribution),
        avgDiscJson: JSON.stringify(stats.avgDisc),
        mapRecommendationLabel
      });
    }
  });

  server.route({
    method: 'GET',
    path: '/hr/api/candidates',
    options: {
      auth: 'hr-jwt'
    },
    handler: async (request, h) => {
      const { search = '', role = '', recommendation = '' } = request.query;
      const candidates = listCandidates({ search, role, recommendation });
      const stats = buildDashboardStats(candidates);
      return h.response({
        candidates,
        stats,
        filters: { search, role, recommendation }
      });
    }
  });

  server.route({
    method: 'GET',
    path: '/hr/candidates/{id}',
    options: {
      auth: 'hr-jwt'
    },
    handler: async (request, h) => {
      const candidate = getCandidateById(Number(request.params.id));
      if (!candidate) {
        return h.response('Candidate not found').code(404);
      }

      const answers = getAnswersForCandidate(candidate.id);
      const answerMap = {};
      answers.forEach((ans) => {
        if (!answerMap[ans.question_id]) {
          answerMap[ans.question_id] = { most: '-', least: '-' };
        }
        answerMap[ans.question_id][ans.answer_type] = ans.option_code;
      });
      const answeredQuestionIds = Object.keys(answerMap).map(Number).sort((a, b) => a - b);
      const questionsForProfile = answeredQuestionIds.map((id) => ({ id }));

      return h.view('candidate-profile', {
        pageTitle: `Profil Kandidat #${candidate.id}`,
        candidate,
        answers,
        answerMap,
        questions: questionsForProfile,
        recommendationLabel: mapRecommendationLabel(candidate.recommendation),
        discDataJson: JSON.stringify({
          D: candidate.disc_d || 0,
          I: candidate.disc_i || 0,
          S: candidate.disc_s || 0,
          C: candidate.disc_c || 0
        }),
        roleScoreJson: JSON.stringify({
          server: candidate.score_server || 0,
          beverage: candidate.score_beverage || 0,
          cook: candidate.score_cook || 0
        })
      });
    }
  });

  server.route({
    method: 'POST',
    path: '/hr/candidates/{id}/delete',
    options: {
      auth: 'hr-jwt'
    },
    handler: async (request, h) => {
      const candidateId = Number(request.params.id);
      if (!Number.isFinite(candidateId)) {
        return h.response('Invalid candidate id').code(400);
      }
      const deleted = deleteCandidateById(candidateId);
      if (!deleted) {
        return h.response('Candidate not found').code(404);
      }
      return h.redirect('/hr/dashboard');
    }
  });

  server.route({
    method: 'DELETE',
    path: '/hr/api/candidates/{id}',
    options: {
      auth: 'hr-jwt'
    },
    handler: async (request, h) => {
      const candidateId = Number(request.params.id);
      if (!Number.isFinite(candidateId)) {
        return h.response({ ok: false, message: 'Invalid candidate id' }).code(400);
      }
      const deleted = deleteCandidateById(candidateId);
      if (!deleted) {
        return h.response({ ok: false, message: 'Candidate not found' }).code(404);
      }
      return h.response({ ok: true });
    }
  });

  server.route({
    method: 'GET',
    path: '/hr/export/excel',
    options: {
      auth: 'hr-jwt'
    },
    handler: async (request, h) => {
      const candidates = listCandidates({});
      const buffer = await buildExcelReport(candidates);

      return h.response(buffer)
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="disc-report-${Date.now()}.xlsx"`);
    }
  });

  server.route({
    method: 'GET',
    path: '/hr/export/pdf',
    options: {
      auth: 'hr-jwt'
    },
    handler: async (request, h) => {
      const candidates = listCandidates({});
      const buffer = await buildPdfReport(candidates);

      return h.response(buffer)
        .type('application/pdf')
        .header('Content-Disposition', `attachment; filename="disc-report-${Date.now()}.pdf"`);
    }
  });

  return server;
}

async function start() {
  const server = await createServer();
  await server.start();
  // eslint-disable-next-line no-console
  console.log(`Server running at: ${server.info.uri}`);
}

process.on('unhandledRejection', (err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

if (require.main === module) {
  start();
}

module.exports = {
  createServer
};
