const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

// Helper function to ensure references are properly numbered
function fixReferencesInLatex(latex) {
  // Find all \bibitem entries and number them sequentially
  const bibitemPattern = /\\bibitem(?:\{\d+\})?/g;
  let bibitemCount = 0;
  
  let fixedLatex = latex.replace(bibitemPattern, (match) => {
    bibitemCount++;
    return `\\bibitem{${bibitemCount}}`;
  });

  // Now fix all \cite commands to match the bibitem numbers
  const citationPattern = /\\cite\s*\{([^}]*)\}/g;
  const citationMap = new Map();
  let citationCount = 0;

  // First pass: build citation map from content order
  fixedLatex = fixedLatex.replace(citationPattern, (match, ref) => {
    if (!citationMap.has(ref)) {
      citationCount++;
      citationMap.set(ref, citationCount);
    }
    return `\\cite{${citationMap.get(ref)}}`;
  });

  return fixedLatex;
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Server is running!', timestamp: new Date().toISOString() });
});

// Main formatting endpoint
app.post('/api/format', upload.fields([
  { name: 'paper', maxCount: 1 },
  { name: 'template', maxCount: 1 },
  { name: 'figures', maxCount: 100 }
]), async (req, res) => {
  try {
    console.log('Received formatting request...');
    
    const paperFile = req.files['paper']?.[0];
    const templateFile = req.files['template']?.[0];
    const figuresFiles = req.files['figures'] || [];
    const apiKey = req.body.apiKey || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY;
    const provider = req.body.provider || 'groq'; // 'groq' or 'gemini'

    if (!paperFile || !templateFile) {
      return res.status(400).json({ 
        success: false, 
        error: 'Both paper and template files are required' 
      });
    }

    if (!apiKey) {
      return res.status(400).json({ 
        success: false, 
        error: 'API key is required' 
      });
    }

    console.log('Extracting text from DOCX...');
    const paperResult = await mammoth.extractRawText({
      buffer: paperFile.buffer
    });
    const paperContent = paperResult.value;
    console.log(`Extracted ${paperContent.length} characters from paper`);
    
    console.log('Reading template...');
    const templateContent = templateFile.buffer.toString('utf-8');
    console.log(`Template length: ${templateContent.length} characters`);

    const prompt = `You are an expert in LaTeX formatting for academic papers. I need you to format a research paper according to a given LaTeX template.

**Paper Content (extracted from DOCX):**
${paperContent}

**LaTeX Template:**
${templateContent}

**Available Figures:**
${figuresFiles.length > 0 ? figuresFiles.map((f, i) => `${i + 1}. ${f.originalname}`).join('\n') : 'No figures provided'}

**Instructions:**
1. Carefully analyze the paper content and identify:
   - Title
   - Authors and affiliations
   - Abstract
   - Introduction and all sections
   - Methodology/methods
   - Results
   - Discussion/Conclusion
   - References/Bibliography
   - Figures and their captions

2. Study the LaTeX template structure:
   - Document class and options
   - Required packages
   - Title/author format
   - Section formatting
   - Reference style

3. For Figures:
   - Detect figure references in the paper (e.g., "Figure 1", "Fig. 2")
   - Create proper LaTeX figure environments with appropriate filenames
   - Use placeholder filenames based on the provided figure list: ${figuresFiles.length > 0 ? figuresFiles.map((f, i) => `figure${i + 1}.png`).join(', ') : 'figure1.png, figure2.png, etc.'}
   - Add proper captions and labels
   - Include \ref{} citations in text

4. For References - CRITICAL:
   - Extract ALL bibliography entries from the paper content
   - MUST format as: \bibitem{1} for first reference, \bibitem{2} for second, etc.
   - MUST use \cite{1}, \cite{2}, \cite{3} format in the text when referencing
   - MUST number starting from [1] NOT [0]
   - Create proper \begin{thebibliography}{99} environment
   - Every reference must have a number: [1], [2], [3]... NOT blank or [0]
   - Example: \bibitem{1} Author Name. Paper Title. Journal Name, 2020.
   - In text: See reference \cite{1} for details on...

5. Generate complete LaTeX code that:
   - Uses the exact template structure
   - Includes all template packages and settings
   - Formats the paper content according to template guidelines
   - Preserves EVERY SINGLE WORD from the original paper - do NOT skip any paragraphs or sections
   - Include ALL figures with proper captions and citations
   - Include ALL references with proper numbers [1], [2], [3]...
   - Follows proper LaTeX syntax
   - Includes proper escaping of special characters
   - Do NOT omit any content - include introduction, methods, results, discussion, conclusions, and ALL references

6. CRITICAL OUTPUT REQUIREMENTS:
   - Output ONLY the complete LaTeX code
   - Start with \\documentclass
   - End with \\end{document}
   - Include EVERY paragraph, section, and subsection from the original paper
   - Include EVERY reference with sequential numbering [1], [2], [3]...
   - Each citation in text MUST be \cite{X} where X is the reference number
   - If original paper mentions "reference [5]", output must use \\cite{5} in text and \\bibitem{5} in references
   - Do NOT abbreviate, truncate, or skip ANY content
   - NO explanations, NO markdown code blocks
   - ONLY pure LaTeX code with complete content

FINAL INSTRUCTION: Generate the COMPLETE formatted LaTeX document with ALL references numbered and ALL content preserved:`;

    let response, data;

    if (provider === 'groq') {
      console.log('Calling Groq API (Llama 3.3 70B)...');
      
      response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: 'You are an expert LaTeX formatter. Output only LaTeX code with no explanations. Include ALL content from the paper including title, abstract, all sections, and ALL references.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.2,
          max_tokens: 32000,
          top_p: 0.9
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Groq API error:', errorText);
        throw new Error(`Groq API returned ${response.status}: ${errorText.substring(0, 300)}`);
      }

      data = await response.json();
      console.log('Received response from Groq');

      if (data.choices?.[0]?.message?.content) {
        let latex = data.choices[0].message.content;
        
        // Clean up
        latex = latex
          .replace(/```latex\n?/g, '')
          .replace(/```tex\n?/g, '')
          .replace(/```\n?/g, '')
          .trim();
        
        if (!latex.startsWith('\\documentclass')) {
          const docStart = latex.indexOf('\\documentclass');
          if (docStart !== -1) {
            latex = latex.substring(docStart);
          }
        }

        // Fix references to ensure proper numbering
        latex = fixReferencesInLatex(latex);
        
        console.log(`✅ LaTeX generated successfully! Length: ${latex.length} characters`);
        res.json({ 
          success: true, 
          latex,
          figures: figuresFiles.map((f, i) => ({
            name: f.originalname,
            placeholder: `figure${i + 1}.png`,
            index: i + 1
          }))
        });
      } else {
        throw new Error('No valid response from Groq AI');
      }
    } else {
      // Gemini fallback
      console.log('Calling Gemini 2.0 Flash API...');
      
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 32000,
              topP: 0.9,
              topK: 40
            }
          })
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Gemini API error:', errorText);
        throw new Error(`Gemini API returned ${response.status}: ${errorText.substring(0, 300)}`);
      }

      data = await response.json();
      console.log('Received response from Gemini');
      
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        let latex = data.candidates[0].content.parts[0].text;
        
        latex = latex
          .replace(/```latex\n?/g, '')
          .replace(/```tex\n?/g, '')
          .replace(/```\n?/g, '')
          .trim();
        
        if (!latex.startsWith('\\documentclass')) {
          const docStart = latex.indexOf('\\documentclass');
          if (docStart !== -1) {
            latex = latex.substring(docStart);
          }
        }

        // Fix references to ensure proper numbering
        latex = fixReferencesInLatex(latex);
        
        console.log(`✅ LaTeX generated successfully! Length: ${latex.length} characters`);
        res.json({ 
          success: true, 
          latex,
          figures: figuresFiles.map((f, i) => ({
            name: f.originalname,
            placeholder: `figure${i + 1}.png`,
            index: i + 1
          }))
        });
      } else {
        throw new Error('No valid response from Gemini AI');
      }
    }
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`🤖 Supports: Groq (Llama 3.3) & Google Gemini 2.0`);
  console.log(`📝 API endpoint: http://localhost:${PORT}/api/format`);
  console.log(`🔍 Health check: http://localhost:${PORT}`);
  console.log(`${'='.repeat(60)}\n`);
});