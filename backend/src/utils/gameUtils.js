import crypto from 'crypto';

class GameUtils {
  // Helper method to format number with 2 decimal places
  formatMultiplier(value) {
    // Convert to number if not already a number
    const numValue = Number(value);
    
    // Check if conversion was successful
    if (isNaN(numValue)) {
      console.warn(`Invalid multiplier value: ${value}. Defaulting to 1.00`);
      return '1.00';
    }
    
    // Format to 2 decimal places
    return numValue.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // Generate a cryptographically secure and unpredictable crash point
  generateCrashPoint() {
    try {
      // Use multiple sources of randomness
      const randomBytes = crypto.randomBytes(4);
      const timestamp = Date.now();
      
      // Create a hash using both random bytes and timestamp
      const hash = crypto.createHash('sha256')
        .update(randomBytes)
        .update(timestamp.toString())
        .digest('hex');
      
      // Convert hash to a number and normalize
      const hashNumber = parseInt(hash.slice(0, 8), 16);
      const normalizedValue = hashNumber / 0xFFFFFFFF;
      
      // Implement a non-linear crash point generation
      const baseCrashPoint = 5;  // Minimum crash point set to 5
      const maxCrashPoint = 50;  // Maximum crash point
      
      // Use an exponential distribution with added randomness
      const exponentFactor = -Math.log(normalizedValue || 0.5);
      const randomVariation = 1 + (Math.random() * 0.5 - 0.25); // +/- 25% variation
      
      // Calculate crash point with multiple factors
      const crashPoint = Math.max(
        baseCrashPoint, 
        Math.min(
          maxCrashPoint, 
          Number((exponentFactor * randomVariation + baseCrashPoint).toFixed(2))
        )
      );
      
      return crashPoint;
    } catch (error) {
      console.error('Error generating crash point:', error);
      return 5; // Safe default
    }
  }

  // Generate unique game UUID
  generateGameUUID() {
    return crypto.randomUUID();
  }

  // Simulate multiplier progression
  simulateMultiplierProgression(currentMultiplier, crashPoint) {
    // Increment by 0.01 with randomness
    const increment = 0.01 * (1 + Math.random() * 0.2 - 0.1);
    const newMultiplier = Math.min(
      Number((currentMultiplier + increment).toFixed(2)), 
      crashPoint
    );
    
    return newMultiplier;
  }
}

/**
 * Format number with commas and two decimal places
 * @param {number} number - Number to format
 * @param {string} [currency=''] - Optional currency symbol
 * @returns {string} Formatted number with commas
 */
function formatCurrency(number, currency = '') {
  if (number == null) return '';
  
  // Ensure number is converted to a number and fixed to 2 decimal places
  const formattedNumber = Number(number).toFixed(2);
  
  // Split into integer and decimal parts
  const [integerPart, decimalPart] = formattedNumber.split('.');
  
  // Add commas to integer part
  const formattedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  
  // Combine parts with optional currency
  return `${currency}${formattedInteger}.${decimalPart}`;
}

export default new GameUtils();
export { formatCurrency };
