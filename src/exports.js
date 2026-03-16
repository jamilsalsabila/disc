'use strict';

const ExcelJS = require('exceljs');
const PdfKit = require('pdfkit');

function mapRecommendationLabel(rec) {
  const map = {
    SERVER_SPECIALIST: 'Server Specialist',
    BEVERAGE_SPECIALIST: 'Beverage Specialist',
    SENIOR_COOK: 'Senior Cook',
    INCOMPLETE: 'Incomplete',
    TIDAK_DIREKOMENDASIKAN: 'Tidak Direkomendasikan'
  };
  return map[rec] || '-';
}

async function buildExcelReport(candidates) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('DISC Results');

  sheet.columns = [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Nama', key: 'name', width: 28 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'WA', key: 'wa', width: 20 },
    { header: 'Role Dipilih', key: 'selectedRole', width: 20 },
    { header: 'Rekomendasi', key: 'recommendation', width: 22 },
    { header: 'D', key: 'd', width: 8 },
    { header: 'I', key: 'i', width: 8 },
    { header: 'S', key: 's', width: 8 },
    { header: 'C', key: 'c', width: 8 },
    { header: 'Score Server', key: 'server', width: 14 },
    { header: 'Score Beverage', key: 'beverage', width: 14 },
    { header: 'Score Cook', key: 'cook', width: 12 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Submitted At', key: 'submittedAt', width: 24 },
    { header: 'Alasan', key: 'reason', width: 60 }
  ];

  candidates.forEach((c) => {
    sheet.addRow({
      id: c.id,
      name: c.full_name,
      email: c.email,
      wa: c.whatsapp,
      selectedRole: c.selected_role,
      recommendation: mapRecommendationLabel(c.recommendation),
      d: c.disc_d,
      i: c.disc_i,
      s: c.disc_s,
      c: c.disc_c,
      server: c.score_server,
      beverage: c.score_beverage,
      cook: c.score_cook,
      status: c.status,
      submittedAt: c.submitted_at,
      reason: c.reason
    });
  });

  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = {
    from: 'A1',
    to: 'P1'
  };

  return workbook.xlsx.writeBuffer();
}

function buildPdfReport(candidates) {
  return new Promise((resolve, reject) => {
    const doc = new PdfKit({ margin: 40, size: 'A4' });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).text('DISC Candidate Report', { align: 'left' });
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Generated at: ${new Date().toISOString()}`);
    doc.moveDown();

    candidates.forEach((c, index) => {
      doc.fontSize(12).text(`${index + 1}. ${c.full_name} (#${c.id})`, { underline: true });
      doc.fontSize(10).text(`Email: ${c.email}`);
      doc.text(`WA: ${c.whatsapp}`);
      doc.text(`Role dipilih: ${c.selected_role}`);
      doc.text(`Rekomendasi: ${mapRecommendationLabel(c.recommendation)}`);
      doc.text(`DISC: D ${c.disc_d || 0} | I ${c.disc_i || 0} | S ${c.disc_s || 0} | C ${c.disc_c || 0}`);
      doc.text(`Score: Server ${c.score_server || 0}% | Beverage ${c.score_beverage || 0}% | Cook ${c.score_cook || 0}%`);
      doc.text(`Status: ${c.status} | Submitted: ${c.submitted_at || '-'}`);
      doc.text(`Alasan: ${c.reason || '-'}`);
      doc.moveDown();

      if (doc.y > 730) {
        doc.addPage();
      }
    });

    doc.end();
  });
}

module.exports = {
  mapRecommendationLabel,
  buildExcelReport,
  buildPdfReport
};
