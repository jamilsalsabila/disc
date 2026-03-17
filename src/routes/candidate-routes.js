'use strict';

const Crypto = require('crypto');
const Joi = require('joi');

const {
  ROLE_OPTIONS,
  TEST_DURATION_MINUTES,
  MIN_COMPLETION_RATIO
} = require('../config/env');
const {
  createCandidate,
  getCandidateById,
  getInProgressCandidateByBrowserToken,
  findCandidateByIdentity,
  listQuestions,
  saveSubmission
} = require('../db');
const { evaluateCandidate } = require('../scoring');
const { mapRecommendationLabel } = require('../exports');
const { nowIso, secondsBetween } = require('../utils/time');
const {
  toDiscPayload,
  buildIncompleteEvaluation,
  buildAnswersFromPayload
} = require('../services/disc-service');
const { normalizeEmail, normalizeWhatsapp } = require('../utils/identity');

function registerCandidateRoutes(server) {
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
        failAction: async (request, h) => {
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

      const emailKey = normalizeEmail(request.payload.email);
      const whatsappKey = normalizeWhatsapp(request.payload.whatsapp);

      const activeByBrowser = getInProgressCandidateByBrowserToken(browserToken);
      if (activeByBrowser) {
        request.cookieAuth.set({ candidateId: activeByBrowser.id });
        return h.redirect('/test');
      }

      const existingCandidate = findCandidateByIdentity({ emailKey, whatsappKey });
      if (existingCandidate) {
        if (existingCandidate.status === 'in_progress' && existingCandidate.browser_token === browserToken) {
          request.cookieAuth.set({ candidateId: existingCandidate.id });
          return h.redirect('/test');
        }

        return h.view('identity', {
          pageTitle: 'Tes DISC Kandidat',
          roleOptions: ROLE_OPTIONS,
          errorMessage: `Kandidat dengan email/WA ini sudah pernah terdaftar (ID #${existingCandidate.id}) dan tidak bisa mengikuti tes lebih dari satu kali.`,
          values: request.payload
        }).code(409);
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
        emailKey,
        whatsapp: request.payload.whatsapp,
        whatsappKey,
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
    options: { auth: 'session' },
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
        const evaluation = evaluateCandidate({}, candidate.selected_role);
        saveSubmission({
          candidateId: candidate.id,
          answers: {},
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
    options: { auth: 'session' },
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

      if (answeredCount !== questions.length) {
        if (expired) {
          const baseEvaluation = evaluateCandidate(toDiscPayload(answers), candidate.selected_role);
          const evaluation = answeredCount < minimumRequired
            ? buildIncompleteEvaluation(baseEvaluation, answeredCount, questions.length)
            : baseEvaluation;

          saveSubmission({
            candidateId: candidate.id,
            answers,
            submittedAt,
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
          durationMinutes: TEST_DURATION_MINUTES,
          errorMessage: 'Semua nomor harus diisi Most dan Least, dan tidak boleh memilih opsi yang sama.'
        }).code(400);
      }

      const evaluation = evaluateCandidate(toDiscPayload(answers), candidate.selected_role);
      saveSubmission({
        candidateId: candidate.id,
        answers,
        submittedAt,
        durationSeconds: secondsBetween(candidate.started_at, expired ? candidate.deadline_at : submittedAt),
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
}

module.exports = {
  registerCandidateRoutes
};
