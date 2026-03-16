'use strict';

const ROLE_PROFILES = {
  SERVER_SPECIALIST: {
    label: 'Server Specialist',
    weights: { D: 0.1, I: 0.45, S: 0.3, C: 0.15 },
    gates: { I: 6, S: 4 }
  },
  BEVERAGE_SPECIALIST: {
    label: 'Beverage Specialist',
    weights: { D: 0.2, I: 0.3, S: 0.15, C: 0.35 },
    gates: { I: 5, C: 5 }
  },
  SENIOR_COOK: {
    label: 'Senior Cook',
    weights: { D: 0.25, I: 0.1, S: 0.2, C: 0.45 },
    gates: { D: 5, C: 7 }
  }
};

const DISC_LABELS = {
  D: 'Dominance',
  I: 'Influence',
  S: 'Steadiness',
  C: 'Conscientiousness'
};

function toPct(value, total) {
  return total ? value / total : 0;
}

function calculateRoleFitPercent(compositeCounts, weights, totalQuestions) {
  const maxTraitScore = totalQuestions * 2;
  const d = toPct(compositeCounts.D, maxTraitScore);
  const i = toPct(compositeCounts.I, maxTraitScore);
  const s = toPct(compositeCounts.S, maxTraitScore);
  const c = toPct(compositeCounts.C, maxTraitScore);

  const score = (d * weights.D) + (i * weights.I) + (s * weights.S) + (c * weights.C);
  return Math.round(score * 100);
}

function rankDiscTraits(discCounts) {
  return Object.entries(discCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);
}

function passesGate(discCounts, gates) {
  return Object.entries(gates).every(([trait, minValue]) => discCounts[trait] >= minValue);
}

function generateReason(recommendation, mostCounts, leastCounts, compositeCounts, roleScores, preferredRoleLabel) {
  const rankedTraits = rankDiscTraits(compositeCounts);
  const avoidedTraits = rankDiscTraits(leastCounts).slice(0, 2);
  const topTraits = rankedTraits
    .slice(0, 2)
    .map((t) => `${DISC_LABELS[t]} (Most ${mostCounts[t]}, Least ${leastCounts[t]})`)
    .join(' & ');

  if (recommendation === 'TIDAK_DIREKOMENDASIKAN') {
    return `Profil DISC menunjukkan kekuatan pada ${topTraits}, namun kecocokan minimum untuk 3 role utama belum terpenuhi. Area yang paling sering dihindari: ${avoidedTraits.map((t) => DISC_LABELS[t]).join(' & ')}.`;
  }

  const recLabel = ROLE_PROFILES[recommendation].label;
  const scoreParts = Object.entries(roleScores)
    .map(([key, val]) => `${ROLE_PROFILES[key].label}: ${val}%`)
    .join(', ');

  const preferredNote = preferredRoleLabel && preferredRoleLabel !== recLabel
    ? ` Role dipilih kandidat: ${preferredRoleLabel}, namun data menunjukkan kecocokan lebih kuat di ${recLabel}.`
    : '';

  return `Kandidat direkomendasikan sebagai ${recLabel} karena kombinasi trait utama ${topTraits} paling sesuai dengan profil role.${preferredNote} Skor per role: ${scoreParts}.`;
}

function evaluateCandidate(answersByQuestion, preferredRoleLabel) {
  const totalQuestions = Object.keys(answersByQuestion).length;
  const mostCounts = { D: 0, I: 0, S: 0, C: 0 };
  const leastCounts = { D: 0, I: 0, S: 0, C: 0 };

  Object.values(answersByQuestion).forEach((answer) => {
    if (answer.mostDisc && mostCounts[answer.mostDisc] !== undefined) {
      mostCounts[answer.mostDisc] += 1;
    }
    if (answer.leastDisc && leastCounts[answer.leastDisc] !== undefined) {
      leastCounts[answer.leastDisc] += 1;
    }
  });

  const compositeCounts = {
    D: mostCounts.D + Math.max(0, totalQuestions - leastCounts.D),
    I: mostCounts.I + Math.max(0, totalQuestions - leastCounts.I),
    S: mostCounts.S + Math.max(0, totalQuestions - leastCounts.S),
    C: mostCounts.C + Math.max(0, totalQuestions - leastCounts.C)
  };

  const roleScores = {};
  const eligibleRoles = [];

  Object.entries(ROLE_PROFILES).forEach(([roleKey, profile]) => {
    const fit = calculateRoleFitPercent(compositeCounts, profile.weights, totalQuestions);
    roleScores[roleKey] = fit;
    if (fit >= 55 && passesGate(mostCounts, profile.gates)) {
      eligibleRoles.push(roleKey);
    }
  });

  let recommendation = 'TIDAK_DIREKOMENDASIKAN';

  if (eligibleRoles.length > 0) {
    recommendation = eligibleRoles.sort((a, b) => roleScores[b] - roleScores[a])[0];
  }

  const reason = generateReason(
    recommendation,
    mostCounts,
    leastCounts,
    compositeCounts,
    roleScores,
    preferredRoleLabel
  );

  return {
    discCounts: compositeCounts,
    mostCounts,
    leastCounts,
    roleScores,
    recommendation,
    reason
  };
}

module.exports = {
  ROLE_PROFILES,
  DISC_LABELS,
  evaluateCandidate
};
