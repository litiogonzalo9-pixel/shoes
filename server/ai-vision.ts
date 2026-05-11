import OpenAI from 'openai';
import { detectBrandFromFilename, PENDING_REVIEW_BRAND } from './brand-detection';

// Initialize OpenAI client with API key from environment (optional)
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Types for AI Vision response
export interface BrandDetectionResult {
  brand: string;
  confidence: number;
  reasoning: string;
}

// Brand mapping for consistent naming (legacy - kept for compatibility)
const BRAND_MAPPINGS: Record<string, string> = {
  'nike': 'Nike',
  'adidas': 'Adidas', 
  'jordan': 'Jordan Air',
  'air jordan': 'Jordan Air',
  'puma': 'Puma',
  'converse': 'Converse',
  'vans': 'Vans',
  'new balance': 'New Balance',
  'newbalance': 'New Balance',
  'reebok': 'Reebok',
  'fila': 'Fila',
  'under armour': 'Under Armour',
  'underarmour': 'Under Armour',
  'asics': 'Asics',
  'skechers': 'Skechers',
  'timberland': 'Timberland',
  'balenciaga': 'Balenciaga',
  'gucci': 'Gucci',
  'yeezy': 'Adidas', // Yeezy is under Adidas
  'off-white': 'Nike', // Collaboration typically under Nike
  'supreme': 'Nike', // Supreme collabs often with Nike
};

// 🤖 INTERNAL ADVANCED BRAND DETECTION: Same robust logic as in routes.ts
// This handles ALL filename types with intelligent fallbacks to prevent "CATÁLOGO GENERAL"
function detectBrandFromFilenameInternal(filename: string): { brandName: string | null; confidence: number } {
  // 🛡️ REPLACED: Using new precise detection module as fallback
  const result = detectBrandFromFilename(filename);
  return {
    brandName: result.requiresReview ? PENDING_REVIEW_BRAND : result.brandName,
    confidence: result.confidence
  };
}

// 🚨 LEGACY CODE COMPLETELY REMOVED - Server now uses ONLY brand-detection.ts as single source of truth

// Convert detected brand to standardized name
function normalizeBrandName(detectedBrand: string): string {
  const normalized = detectedBrand.toLowerCase().trim();
  return BRAND_MAPPINGS[normalized] || detectedBrand;
}

/**
 * 🤖 AI VISUAL BRAND DETECTION: Uses GPT-5 Vision to analyze shoe images and detect brands
 * @param imageUrl - URL of the shoe image to analyze
 * @returns Promise with brand detection result including confidence and reasoning
 */
export async function detectBrandFromImage(imageUrl: string): Promise<BrandDetectionResult> {
  try {
    console.log(`🔍 Starting AI visual analysis for image: ${imageUrl}`);
    
    // Specialized prompt for shoe brand detection
    const prompt = `Analyze this shoe/footwear image and identify the brand. Look for:

VISUAL BRAND INDICATORS:
- Brand logos (Nike swoosh, Adidas stripes, Converse star, Vans side stripe, etc.)
- Brand-specific design elements (Air Jordan Jumpman, Puma cat, New Balance "N", etc.)
- Distinctive colorways and silhouettes
- Text/lettering on the shoe
- Brand-specific patterns, materials, or construction details

FOCUS ON THESE MAJOR BRANDS:
Nike, Adidas, Jordan Air, Puma, Converse, Vans, New Balance, Reebok, Fila, Under Armour, Asics, Skechers, Timberland, Balenciaga, Gucci

RESPONSE FORMAT:
Return ONLY a JSON object with these exact fields:
{
  "brand": "Exact brand name or 'Unknown' if uncertain",
  "confidence": 0.85,
  "reasoning": "Brief explanation of visual evidence found"
}

CONFIDENCE SCALE:
- 0.9-1.0: Clear logo/branding visible
- 0.7-0.9: Strong design indicators 
- 0.5-0.7: Some recognizable features
- 0.3-0.5: Weak indicators
- 0.0-0.3: No clear brand evidence

Be conservative with confidence - only high scores for clear visual evidence.`;

    if (!openai) {
      throw new Error('Missing OPENAI_API_KEY. Falling back to filename-based detection.');
    }

    // Call OpenAI GPT-4 Vision (currently the most advanced vision model available)
    const response = await openai.chat.completions.create({
      model: "gpt-4o", // Using GPT-4o which has excellent vision capabilities
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt
            },
            {
              type: "image_url",
              image_url: {
                url: imageUrl,
                detail: "high" // High detail for better brand recognition
              }
            }
          ]
        }
      ],
      max_tokens: 500,
      temperature: 0.1, // Low temperature for consistent, focused analysis
    });

    const aiResponse = response.choices[0]?.message?.content;
    
    if (!aiResponse) {
      throw new Error('No response from AI vision service');
    }

    console.log(`🤖 Raw AI response: ${aiResponse}`);

    // Parse JSON response from AI
    let parsedResponse: any;
    try {
      // Extract JSON from response (in case AI adds extra text)
      const jsonMatch = aiResponse.match(/\{[^}]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in AI response');
      }
      parsedResponse = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      console.error('Failed to parse AI response as JSON:', aiResponse);
      // Fallback parsing - try to extract key information
      const brandMatch = aiResponse.toLowerCase().match(/brand["\s:]*["']?([^"',\n]+)["']?/);
      const confidenceMatch = aiResponse.match(/confidence["\s:]*(\d*\.?\d+)/);
      
      return {
        brand: brandMatch ? normalizeBrandName(brandMatch[1].trim()) : 'Unknown',
        confidence: confidenceMatch ? Math.min(parseFloat(confidenceMatch[1]), 1.0) : 0.2,
        reasoning: 'AI response parsing failed, extracted basic info'
      };
    }

    // Validate and normalize the response
    const result: BrandDetectionResult = {
      brand: parsedResponse.brand ? normalizeBrandName(parsedResponse.brand) : 'Unknown',
      confidence: Math.min(Math.max(parseFloat(parsedResponse.confidence) || 0, 0), 1), // Clamp 0-1
      reasoning: parsedResponse.reasoning || 'AI analysis completed'
    };

    // Additional validation - reduce confidence for "Unknown" brands
    if (result.brand === 'Unknown' && result.confidence > 0.5) {
      result.confidence = Math.min(result.confidence, 0.3);
      result.reasoning += ' (confidence reduced for unknown brand)';
    }

    console.log(`✅ AI brand detection result: ${result.brand} (confidence: ${result.confidence})`);
    console.log(`📋 Reasoning: ${result.reasoning}`);

    return result;

  } catch (error) {
    console.error('❌ Error in AI visual brand detection:', error);
    
    // 🆘 INTELLIGENT FALLBACK: When AI fails, use filename-based detection
    // This is CRITICAL for handling OpenAI quota errors (429) and ensuring NO products go to "CATÁLOGO GENERAL"
    console.log('🔄 AI failed, switching to intelligent filename fallback...');
    
    // Extract filename from imageUrl (assumes format like: "/uploads/filename.jpg")
    let filename = 'unknown.jpg';
    try {
      const urlParts = imageUrl.split('/');
      filename = urlParts[urlParts.length - 1] || 'unknown.jpg';
      console.log(`📄 Extracted filename for fallback: ${filename}`);
    } catch (urlError) {
      console.warn('Could not extract filename from URL, using fallback distribution');
    }
    
    // Use the enhanced detectBrandFromFilename function (internal implementation)
    // This ensures the same robust detection logic is applied
    const filenameDetection = detectBrandFromFilenameInternal(filename);
    
    // Convert filename detection result to AI format
    const fallbackResult: BrandDetectionResult = {
      brand: filenameDetection.brandName || 'Nike', // Default to Nike if somehow null (should never happen)
      confidence: Math.max(filenameDetection.confidence, 0.3), // Minimum 30% confidence for fallback
      reasoning: `AI vision failed (${error instanceof Error ? error.message : 'Unknown error'}). Used intelligent filename detection instead.`
    };
    
    // Special handling for OpenAI quota errors
    if (error instanceof Error && (error.message.includes('429') || error.message.includes('quota'))) {
      fallbackResult.reasoning = 'OpenAI quota exhausted. Used enhanced filename-based brand detection with pattern recognition.';
      console.log('🚨 OpenAI quota error detected - filename fallback activated');
    }
    
    console.log(`✅ Fallback detection result: ${fallbackResult.brand} (confidence: ${fallbackResult.confidence})`);
    return fallbackResult;
  }
}

/**
 * 🔧 UTILITY: Convert image to base64 for AI analysis (if needed for local images)
 * Currently using URLs directly, but this can be used for uploaded files
 */
export async function convertImageToBase64(imagePath: string): Promise<string> {
  try {
    const fs = await import('fs');
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    
    // Detect file type for proper data URL format
    const ext = imagePath.split('.').pop()?.toLowerCase();
    const mimeType = ext === 'png' ? 'image/png' : 
                    ext === 'gif' ? 'image/gif' : 
                    'image/jpeg'; // Default to JPEG
    
    return `data:${mimeType};base64,${base64Image}`;
  } catch (error) {
    console.error('Error converting image to base64:', error);
    throw error;
  }
}

/**
 * 🎯 COMBINED DETECTION: Merge filename-based and AI visual detection results
 * @param filenameResult - Result from filename-based detection
 * @param visualResult - Result from AI visual analysis  
 * @returns Best combined result with highest confidence
 */
export function combineDetectionResults(
  filenameResult: { brandName: string | null; confidence: number },
  visualResult: BrandDetectionResult
): { brand: string | null; confidence: number; method: string; reasoning: string } {
  
  // Convert filename result to same format
  const filenameFormatted = {
    brand: filenameResult.brandName,
    confidence: filenameResult.confidence,
    method: 'filename',
    reasoning: 'Detected from filename analysis'
  };
  
  const visualFormatted = {
    brand: visualResult.brand === 'Unknown' ? null : visualResult.brand,
    confidence: visualResult.confidence,
    method: 'visual_ai',
    reasoning: visualResult.reasoning
  };
  
  // Combine results - prefer higher confidence, but give slight bonus to visual AI
  if (visualFormatted.confidence > filenameFormatted.confidence + 0.1) {
    console.log(`🎯 Using AI visual detection: ${visualFormatted.brand} (${visualFormatted.confidence} vs filename ${filenameFormatted.confidence})`);
    return visualFormatted;
  } else if (filenameFormatted.confidence > 0.7) {
    console.log(`🎯 Using filename detection: ${filenameFormatted.brand} (${filenameFormatted.confidence} vs visual ${visualFormatted.confidence})`);
    return filenameFormatted;
  } else if (visualFormatted.confidence > 0.5) {
    console.log(`🎯 Using AI visual detection (filename low confidence): ${visualFormatted.brand} (visual ${visualFormatted.confidence})`);
    return visualFormatted;
  } else {
    console.log(`🎯 Both methods low confidence, using filename fallback: ${filenameFormatted.brand}`);
    return filenameFormatted;
  }
}