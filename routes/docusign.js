/**
 * DocuSign Routes
 * Send contracts from base44 via DocuSign
 */

const express = require('express');
const router = express.Router();
const base44 = require('../lib/base44');
const docusign = require('../lib/docusign');

/**
 * GET /api/docusign/templates
 * List available DocuSign templates for the base44 frontend template picker
 */
router.get('/templates', async (req, res) => {
  try {
    const { search } = req.query;
    const result = await docusign.listTemplates(search || '');
    const templates = (result.envelopeTemplates || []).map(t => ({
      templateId: t.templateId,
      name: t.name,
      description: t.description || '',
      created: t.created,
      lastModified: t.lastModified
    }));
    res.json({ templates });
  } catch (error) {
    console.error('Error listing templates:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/docusign/templates/:templateId
 * Get template details (fields, roles) for pre-fill mapping
 */
router.get('/templates/:templateId', async (req, res) => {
  try {
    const template = await docusign.getTemplate(req.params.templateId);
    res.json(template);
  } catch (error) {
    console.error('Error getting template:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/docusign/send-contract
 * Send a contract for signature, pulling data from base44 project/invoice
 */
router.post('/send-contract', async (req, res) => {
  const {
    templateId, projectId, invoiceId, recipientEmail, recipientName,
    roleName = 'Signer', customFields = [],
    emailSubject, emailMessage, sendNow = true
  } = req.body;

  if (!templateId) {
    return res.status(400).json({ error: 'templateId is required' });
  }
  if (!recipientEmail || !recipientName) {
    return res.status(400).json({ error: 'recipientEmail and recipientName are required' });
  }

  try {
    const textTabs = [...customFields];

    // Pull project data if provided
    let project = null;
    if (projectId) {
      try {
        project = await base44.getEntity('Project', projectId);
        if (project) {
          const projectFields = [
            { tabLabel: 'ProjectName', value: project.name || project.project_name || '' },
            { tabLabel: 'ProjectAddress', value: project.address || project.site_address || '' },
            { tabLabel: 'ProjectCity', value: project.city || '' },
            { tabLabel: 'ProjectState', value: project.state || '' },
            { tabLabel: 'ProjectZip', value: project.zip || '' },
            { tabLabel: 'StartDate', value: project.start_date || '' },
            { tabLabel: 'EndDate', value: project.end_date || '' },
            { tabLabel: 'ProjectDescription', value: project.description || '' }
          ].filter(f => f.value);
          textTabs.push(...projectFields);
        }
      } catch (e) {
        console.warn('Could not fetch project ' + projectId + ': ' + e.message);
      }
    }

    // Pull invoice data if provided
    let invoice = null;
    if (invoiceId) {
      try {
        invoice = await base44.getEntity('Invoice', invoiceId);
        if (invoice) {
          const invoiceFields = [
            { tabLabel: 'InvoiceNumber', value: invoice.invoice_number || invoice.number || '' },
            { tabLabel: 'InvoiceTotal', value: String(invoice.total || invoice.amount || '') },
            { tabLabel: 'InvoiceDate', value: invoice.date || invoice.invoice_date || '' },
            { tabLabel: 'DueDate', value: invoice.due_date || '' },
            { tabLabel: 'CompanyName', value: invoice.company_name || '' },
            { tabLabel: 'ClientAddress', value: invoice.billing_address || invoice.address || '' },
            { tabLabel: 'ClientEmail', value: invoice.email || recipientEmail },
            { tabLabel: 'PaymentTerms', value: invoice.payment_terms || '' }
          ].filter(f => f.value);
          textTabs.push(...invoiceFields);

          if (invoice.items || invoice.line_items) {
            const items = invoice.items || invoice.line_items;
            if (Array.isArray(items)) {
              const itemText = items.map((item, i) =>
                (i + 1) + '. ' + (item.name || item.description) + ' - Qty: ' + (item.quantity || 1) + ' - $' + (item.amount || item.price || item.total || 0)
              ).join('\n');
              textTabs.push({ tabLabel: 'LineItems', value: itemText });
            }
          }
        }
      } catch (e) {
        console.warn('Could not fetch invoice ' + invoiceId + ': ' + e.message);
      }
    }

    textTabs.push(
      { tabLabel: 'RecipientName', value: recipientName },
      { tabLabel: 'RecipientEmail', value: recipientEmail }
    );

    const envelope = await docusign.createEnvelopeFromTemplate({
      templateId,
      signer: { email: recipientEmail, name: recipientName, roleName },
      textTabs,
      emailSubject: emailSubject || 'Contract from SOCO Production' + (project ? ' - ' + (project.name || project.project_name || '') : ''),
      emailBlurb: emailMessage || 'Please review and sign the attached document from SOCO Production.',
      status: sendNow ? 'sent' : 'created'
    });

    console.log('Contract sent to ' + recipientName + ' (' + recipientEmail + '), envelope: ' + envelope.envelopeId);

    try {
      await base44.createEntity('ContractLog', {
        project_id: projectId || null,
        invoice_id: invoiceId || null,
        envelope_id: envelope.envelopeId,
        template_id: templateId,
        recipient_name: recipientName,
        recipient_email: recipientEmail,
        status: sendNow ? 'Sent' : 'Draft',
        sent_at: new Date().toISOString()
      });
    } catch (logErr) {
      console.warn('Could not log contract to base44:', logErr.message);
    }

    res.json({
      success: true,
      envelopeId: envelope.envelopeId,
      status: envelope.status,
      statusDateTime: envelope.statusDateTime
    });

  } catch (error) {
    console.error('Error sending contract:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/docusign/send-document
 * Send a document URL for signature
 */
router.post('/send-document', async (req, res) => {
  const {
    documentUrl, documentName = 'Contract',
    recipientEmail, recipientName,
    emailSubject, emailMessage, projectId, invoiceId
  } = req.body;

  if (!documentUrl) {
    return res.status(400).json({ error: 'documentUrl is required' });
  }
  if (!recipientEmail || !recipientName) {
    return res.status(400).json({ error: 'recipientEmail and recipientName are required' });
  }

  try {
    const envelope = await docusign.createEnvelopeFromUrl({
      documentUrl, documentName,
      signer: { email: recipientEmail, name: recipientName },
      emailSubject: emailSubject || 'Document from SOCO Production: ' + documentName,
      emailBlurb: emailMessage || 'Please review and sign the attached document from SOCO Production.'
    });

    console.log('Document "' + documentName + '" sent to ' + recipientName + ', envelope: ' + envelope.envelopeId);

    try {
      await base44.createEntity('ContractLog', {
        project_id: projectId || null,
        invoice_id: invoiceId || null,
        envelope_id: envelope.envelopeId,
        recipient_name: recipientName,
        recipient_email: recipientEmail,
        document_url: documentUrl,
        status: 'Sent',
        sent_at: new Date().toISOString()
      });
    } catch (logErr) {
      console.warn('Could not log contract to base44:', logErr.message);
    }

    res.json({
      success: true,
      envelopeId: envelope.envelopeId,
      status: envelope.status
    });

  } catch (error) {
    console.error('Error sending document:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/docusign/envelope/:envelopeId
 * Check envelope status
 */
router.get('/envelope/:envelopeId', async (req, res) => {
  try {
    const envelope = await docusign.getEnvelope(req.params.envelopeId);
    res.json({
      envelopeId: envelope.envelopeId,
      status: envelope.status,
      statusDateTime: envelope.statusChangedDateTime,
      sentDateTime: envelope.sentDateTime,
      completedDateTime: envelope.completedDateTime
    });
  } catch (error) {
    console.error('Error getting envelope:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
