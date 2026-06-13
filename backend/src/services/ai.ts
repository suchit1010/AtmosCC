/**
 * ATMOS AI Service — Carbon MRV Engine
 * ─────────────────────────────────────────────────────
 * Responsibilities:
 *   1. Carbon estimation per entity type (8 methodologies)
 *   2. Fraud detection (multi-signal)
 *   3. Confidence scoring (8 dimensions)
 *   4. Grade assignment (S/A/B/C/D)
 *   5. Price recommendation
 */

import { query } from '../db/pool';
import { logger } from '../utils/logger';
import type { SatelliteResult } from './satellite';

// ─── Emission factors (IPCC AR6 defaults) ────────────
const EMISSION_FACTORS = {
  coal:        0.820,  // tCO2e / MWh
  natural_gas: 0.490,
  diesel:      0.890,
  furnace_oil: 0.890,
  petrol:      2.310,  // tCO2e / 1000 L
  cng:         1.960,
};

const FUEL_CONSUMPTION = {
  petrol:  0.070, // L/km
  diesel:  0.060,
  cng:     0.055,
};

// ─── Methodology → estimation function ───────────────
type EntityEstimator = (meta: any, sat: SatelliteResult | null) => number;

const estimators: Record<string, EntityEstimator> = {

  biochar(meta, sat) {
    // VM0044: Biochar carbon permanence
    // tCO2e = biochar_yield × stability_factor × 44/12
    const biocharYield     = parseFloat(meta.biocharYieldTonnes   || 0);
    const biomassInput     = parseFloat(meta.biomassAvailableTonnes || biocharYield * 3);
    const stabilityFactor  = 0.78; // fraction of stable carbon (VM0044 default)
    const carbonContent    = 0.60; // fraction of C in biochar
    const co2PerTonneC     = 44 / 12;

    let co2e = biocharYield * stabilityFactor * carbonContent * co2PerTonneC;

    // Satellite corroboration: biomass availability cross-check
    if (sat) {
      const satBiomass = sat.biomassTonesPerHa * (parseFloat(meta.areaHa) || 1);
      const ratio      = satBiomass > 0 ? biomassInput / satBiomass : 1;
      // Penalise if claimed biomass >> satellite biomass
      if (ratio > 2.0) co2e *= 0.70;
      else if (ratio > 1.5) co2e *= 0.85;
    }

    return Math.max(0, co2e);
  },

  agroforestry(meta, sat) {
    // VM0047: Agroforestry carbon sequestration
    // tCO2e = trees × avg_sequestration_per_tree_per_yr × years_to_maturity
    const trees    = parseFloat(meta.treesPlanted || 0);
    const areaHa   = parseFloat(meta.areaHa || 1);
    const seqPerHa = 3.8; // tCO2e/ha/yr (Acacia/Neem mix, IPCC Tier 1)

    let co2e = areaHa * seqPerHa;

    // Adjust for NDVI improvement
    if (sat && sat.ndviCurrent > sat.ndviBaseline) {
      const improvement = (sat.ndviCurrent - sat.ndviBaseline) / sat.ndviBaseline;
      co2e *= (1 + Math.min(improvement, 0.3)); // cap uplift at 30%
    }

    return Math.max(0, co2e);
  },

  soil_carbon(meta, sat) {
    // VM0042: Soil organic carbon improvement
    const areaHa   = parseFloat(meta.areaHa || 1);
    const baseline = parseFloat(meta.baselineSoilCarbon || 1.0); // % SOC
    const current  = parseFloat(meta.currentSoilCarbon  || 1.2);
    const depthM   = 0.30; // 30 cm standard depth
    const bulkDensity = 1300; // kg/m³ typical agricultural soil

    // ΔSoilC (tCO2e) = ΔC% × depth × bulk_density × area × (44/12)
    const deltaC = Math.max(0, current - baseline) / 100;
    const co2e   = deltaC * depthM * (bulkDensity / 1000) * (areaHa * 10000) * (44 / 12) / 1000;

    return Math.max(0, co2e);
  },

  crop_residue(meta, sat) {
    // No-burn management: avoid CH4 + N2O from burning
    const areaHa        = parseFloat(meta.areaHa || 1);
    const residueTonnes = parseFloat(meta.residueTonnes || areaHa * 3.5); // default 3.5t/ha

    // IPCC emission factors for rice straw burning
    const ef_ch4 = 2.7  * 25;  // GWP100
    const ef_n2o = 0.07 * 298;
    const combustion_factor = 0.80;
    const fraction_burned   = parseFloat(meta.fractionBurned || 1.0);

    const co2e = residueTonnes * fraction_burned * combustion_factor *
                 (ef_ch4 + ef_n2o) / 1000;

    // Satellite fire detection corroboration
    if (sat && !sat.fireDetected) {
      return co2e; // Satellite confirms no burning — full credit
    } else if (sat && sat.fireDetected) {
      return co2e * 0.2; // Fire detected — penalise heavily
    }

    return Math.max(0, co2e);
  },

  solar_energy(meta, sat) {
    // CDM AMS-I.D: Grid displacement by solar
    const capacityKW   = parseFloat(meta.capacityKw   || 0);
    const capacityFactor = parseFloat(meta.capacityFactor || 0.20); // 20% CF default India
    const gridEmFactor = 0.82; // India grid: kg CO2/kWh (CEA 2023)

    const annualKwh = capacityKW * capacityFactor * 8760;
    const co2e      = (annualKwh * gridEmFactor) / 1000; // tonnes

    return Math.max(0, co2e);
  },

  ev_fleet(meta, sat) {
    // GHG Protocol: displaced fuel combustion
    const fleetSize        = parseInt(meta.fleetSize || 1);
    const monthlyKm        = parseFloat(meta.monthlyKmElectric || 0);
    const annualKm         = monthlyKm * 12 * fleetSize;
    const fuelType         = (meta.baselineFuelType || 'diesel') as keyof typeof FUEL_CONSUMPTION;
    const consumptionPerKm = FUEL_CONSUMPTION[fuelType] || 0.065;
    const emFactor         = EMISSION_FACTORS[fuelType === 'petrol' ? 'petrol' : 'diesel'] || 0.89;

    const annualLitres = annualKm * consumptionPerKm;
    const co2e         = (annualLitres / 1000) * emFactor;

    // Subtract EV charging emissions (India grid)
    const evEfficiency     = 0.20;    // kWh/km
    const evChargingCo2e   = (annualKm * evEfficiency * 0.82) / 1000;

    return Math.max(0, co2e - evChargingCo2e);
  },

  building(meta, sat) {
    const baselineKwh = parseFloat(meta.baselineEnergyKwh || 0);
    const currentKwh  = parseFloat(meta.currentEnergyKwh  || baselineKwh * 0.7);
    const gridEmFactor = 0.82; // India grid kg CO2/kWh

    const savedKwh = Math.max(0, baselineKwh - currentKwh);
    const co2e     = (savedKwh * gridEmFactor) / 1000;

    return Math.max(0, co2e);
  },

  individual(meta, sat) {
    const action   = meta.action || '';
    const duration = parseFloat(meta.duration || 12); // months
    const quantity = parseFloat(meta.quantity  || 1);
    const years    = duration / 12;

    const perYear: Record<string, number> = {
      'Plant Trees':        0.022 * quantity * years,
      'EV Switch':          1.8   * years,
      'Solar Panels':       1.2   * quantity * years,
      'Vegan Month':        0.08  * quantity,
      'Flight Free Year':   2.5   * years,
      'Bike Commute':       0.45  * years,
    };

    return Math.max(0, perYear[action] || 0.5 * years);
  },
};

// ─── Fraud detection ─────────────────────────────────
interface FraudResult {
  score: number;     // 0 = no fraud, 1 = definite fraud
  risk: 'low' | 'medium' | 'high';
  signals: string[];
}

function detectFraud(
  entityType: string,
  meta: any,
  sat: SatelliteResult | null,
  co2eEstimate: number
): FraudResult {
  let score   = 0;
  const signals: string[] = [];

  // 1. Area sanity check
  const areaHa = parseFloat(meta.areaHa || 0);
  if (areaHa > 50000) {
    score += 0.4; signals.push('area_too_large');
  }

  // 2. Implausibly high carbon yield
  const co2ePerHa = areaHa > 0 ? co2eEstimate / areaHa : 0;
  if (co2ePerHa > 50) {
    score += 0.3; signals.push('co2e_per_ha_too_high');
  }

  // 3. Satellite cross-check: fire during no-burn claim
  if (sat?.fireDetected && entityType === 'crop_residue') {
    score += 0.5; signals.push('fire_detected_during_no_burn');
  }

  // 4. Low NDVI inconsistent with high biomass claim
  if (sat) {
    const claimedBiomass = parseFloat(meta.biomassAvailableTonnes || 0);
    const satBiomass     = sat.biomassTonesPerHa * (areaHa || 1);
    if (claimedBiomass > satBiomass * 3) {
      score += 0.3; signals.push('biomass_claim_exceeds_satellite');
    }
  }

  // 5. Missing critical fields
  const requiredByEntity: Record<string, string[]> = {
    biochar:       ['farmerName', 'areaHa', 'biocharYieldTonnes'],
    agroforestry:  ['farmerName', 'areaHa', 'treesPlanted'],
    crop_residue:  ['farmerName', 'areaHa'],
    ev_fleet:      ['fleetSize', 'monthlyKmElectric'],
    building:      ['baselineEnergyKwh', 'currentEnergyKwh'],
  };
  const required = requiredByEntity[entityType] || [];
  const missing  = required.filter(f => !meta[f]);
  if (missing.length > 0) {
    score += 0.15 * missing.length;
    signals.push(`missing_fields:${missing.join(',')}`);
  }

  // 6. NDVI land-use inconsistency
  if (sat && sat.landConsistency === 'low') {
    score += 0.2; signals.push('land_use_inconsistent');
  }

  const clamped = Math.min(score, 1);
  return {
    score:   clamped,
    risk:    clamped < 0.3 ? 'low' : clamped < 0.6 ? 'medium' : 'high',
    signals,
  };
}

// ─── 8-dimensional confidence scoring ────────────────
interface ConfidenceScores {
  overall:              number;
  activityDetection:    number;
  satelliteConsistency: number;
  dataQuality:          number;
  fraudRisk:            number;
  methodologyMatch:     number;
  permanenceScore:      number;
  coBenefitScore:       number;
  seasonalValidity:     number;
}

function scoreConfidence(
  entityType: string,
  meta: any,
  sat: SatelliteResult | null,
  fraud: FraudResult
): ConfidenceScores {
  // 1. Activity detection (satellite confirms activity)
  const activityDetection = sat
    ? Math.round(
        (sat.cropActivity === 'active' ? 40 : 20) +
        (sat.landConsistency === 'high' ? 35 : sat.landConsistency === 'medium' ? 20 : 5) +
        (sat.confidenceScore * 0.25)
      )
    : 50;

  // 2. Satellite consistency (NDVI change aligns with claim)
  const satelliteConsistency = sat
    ? Math.round(
        Math.min(100,
          70 +
          ((sat.ndviCurrent - sat.ndviBaseline) * 100) +
          (sat.fireDetected ? -30 : 0) +
          (sat.cloudCoverPct < 10 ? 10 : sat.cloudCoverPct < 20 ? 5 : 0)
        )
      )
    : 55;

  // 3. Data quality (metadata completeness)
  const totalFields    = Object.keys(meta).length;
  const filledFields   = Object.values(meta).filter(v => v !== null && v !== '' && v !== undefined).length;
  const dataQuality    = Math.round((filledFields / Math.max(totalFields, 1)) * 100);

  // 4. Fraud risk (inverse of fraud score)
  const fraudRiskScore = Math.round((1 - fraud.score) * 100);

  // 5. Methodology match
  const methodologyMap: Record<string, number> = {
    biochar:      95,
    agroforestry: 88,
    soil_carbon:  82,
    crop_residue: 90,
    solar_energy: 95,
    ev_fleet:     92,
    building:     88,
  };
  const methodologyMatch = methodologyMap[entityType] || 75;

  // 6. Permanence score
  const permanenceMap: Record<string, number> = {
    biochar:      95, // 1000-yr permanence
    agroforestry: 65, // 20-100 yr
    soil_carbon:  70,
    crop_residue: 80, // emission avoidance
    solar_energy: 90,
    ev_fleet:     85,
    building:     85,
    individual:   50,
  };
  const permanenceScore = permanenceMap[entityType] || 70;

  // 7. Co-benefit score (SDG impact)
  const coBenefitMap: Record<string, number> = {
    biochar:      82, // SDG 2,13,15
    agroforestry: 90, // SDG 2,13,15,6
    soil_carbon:  85,
    crop_residue: 78,
    ev_fleet:     72,
    individual:   75,
  };
  const coBenefitScore = coBenefitMap[entityType] || 70;

  // 8. Seasonal validity (project submitted in right season)
  const month           = new Date().getMonth();
  const kharifMonths    = [5, 6, 7, 8, 9];  // Jun-Oct: rice season
  const rabiMonths      = [10, 11, 0, 1, 2]; // Nov-Mar: wheat season
  const isKharif        = kharifMonths.includes(month);
  const claimedCrop     = (meta.cropType || '').toLowerCase();
  const seasonalValid   = (isKharif && claimedCrop.includes('rice')) ||
                          (!isKharif && claimedCrop.includes('wheat'))
                          ? 90 : 75;

  // Overall: weighted average
  const overall = Math.round(
    activityDetection    * 0.20 +
    satelliteConsistency * 0.20 +
    dataQuality          * 0.15 +
    fraudRiskScore       * 0.20 +
    methodologyMatch     * 0.10 +
    permanenceScore      * 0.05 +
    coBenefitScore       * 0.05 +
    seasonalValid        * 0.05
  );

  return {
    overall:              Math.min(100, Math.max(0, overall)),
    activityDetection:    Math.min(100, activityDetection),
    satelliteConsistency: Math.min(100, satelliteConsistency),
    dataQuality:          Math.min(100, dataQuality),
    fraudRisk:            Math.min(100, fraudRiskScore),
    methodologyMatch,
    permanenceScore,
    coBenefitScore,
    seasonalValidity:     seasonalValid,
  };
}

// ─── Grade assignment ─────────────────────────────────
function assignGrade(
  confidence: number,
  fraud: FraudResult,
  entityType: string
): 'S' | 'A' | 'B' | 'C' | 'D' {
  if (fraud.risk === 'high') return 'D';
  if (confidence >= 90 && fraud.risk === 'low') return 'S';
  if (confidence >= 78 && fraud.risk === 'low') return 'A';
  if (confidence >= 62) return 'B';
  if (confidence >= 45) return 'C';
  return 'D';
}

// ─── Price recommendation ─────────────────────────────
function recommendPrice(
  grade: string,
  entityType: string,
  co2e: number
): { minInr: number; maxInr: number; midInr: number } {
  const basePriceInr: Record<string, [number, number]> = {
    S: [1800, 2500],
    A: [1200, 1800],
    B: [700,  1200],
    C: [300,  700],
    D: [100,  300],
  };

  // Methodology premium / discount
  const methodologyMultiplier: Record<string, number> = {
    biochar:      1.25, // CCP-eligible, premium
    agroforestry: 1.10,
    soil_carbon:  1.15,
    crop_residue: 1.00,
    solar_energy: 0.90,
    ev_fleet:     0.95,
    building:     0.92,
    individual:   0.75,
  };

  const [baseMin, baseMax] = basePriceInr[grade] || [300, 700];
  const mult = methodologyMultiplier[entityType] || 1.0;

  return {
    minInr: Math.round(baseMin * mult),
    maxInr: Math.round(baseMax * mult),
    midInr: Math.round(((baseMin + baseMax) / 2) * mult),
  };
}

// ─── Get methodology code ─────────────────────────────
function getMethodology(entityType: string): string {
  const map: Record<string, string> = {
    biochar:      'VM0044',
    agroforestry: 'VM0047',
    soil_carbon:  'VM0042',
    crop_residue: 'VM0042',
    solar_energy: 'AMS-I.D',
    ev_fleet:     'AMS-III.C',
    building:     'AMS-II.C',
    shipping:     'VM0051',
    aviation:     'VM0052',
    individual:   'GHG-IND-01',
    city:         'CDM-AR',
  };
  return map[entityType] || 'VM0042';
}

// ─── MAIN: Run full AI analysis ───────────────────────
export interface AIVerificationResult {
  projectId:            string;
  co2eEstimated:        number;
  co2eLowerBound:       number;
  co2eUpperBound:       number;
  confidence:           ConfidenceScores;
  fraud:                FraudResult;
  grade:                'S' | 'A' | 'B' | 'C' | 'D';
  methodology:          string;
  priceMinInr:          number;
  priceMaxInr:          number;
  priceMidInr:          number;
  vintageYear:          number;
}

export async function runAIVerification(
  projectId:  string,
  entityType: string,
  metadata:   any,
  satellite:  SatelliteResult | null
): Promise<AIVerificationResult> {
  logger.info('Starting AI verification', { projectId, entityType });

  const estimator = estimators[entityType] || estimators.individual;

  // Estimate CO2e
  const co2eBase  = estimator(metadata, satellite);
  const uncertainty = 0.18; // ±18% standard uncertainty

  const fraud      = detectFraud(entityType, metadata, satellite, co2eBase);
  const confidence = scoreConfidence(entityType, metadata, satellite, fraud);
  const grade      = assignGrade(confidence.overall, fraud, entityType);
  const price      = recommendPrice(grade, entityType, co2eBase);
  const methodology = getMethodology(entityType);

  const result: AIVerificationResult = {
    projectId,
    co2eEstimated:    parseFloat(co2eBase.toFixed(4)),
    co2eLowerBound:   parseFloat((co2eBase * (1 - uncertainty)).toFixed(4)),
    co2eUpperBound:   parseFloat((co2eBase * (1 + uncertainty)).toFixed(4)),
    confidence,
    fraud,
    grade,
    methodology,
    priceMinInr:  price.minInr,
    priceMaxInr:  price.maxInr,
    priceMidInr:  price.midInr,
    vintageYear:  new Date().getFullYear(),
  };

  // Persist to DB
  await query(
    `INSERT INTO ai_verifications (
      project_id, co2e_estimated, co2e_lower_bound, co2e_upper_bound,
      confidence_score, fraud_risk, activity_detection,
      satellite_consistency, data_quality, methodology_match,
      permanence_score, co_benefit_score, grade,
      price_min_inr, price_max_inr
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      projectId,
      result.co2eEstimated,
      result.co2eLowerBound,
      result.co2eUpperBound,
      result.confidence.overall,
      result.fraud.risk,
      result.confidence.activityDetection,
      result.confidence.satelliteConsistency,
      result.confidence.dataQuality,
      result.confidence.methodologyMatch,
      result.confidence.permanenceScore,
      result.confidence.coBenefitScore,
      result.grade,
      result.priceMinInr,
      result.priceMaxInr,
    ]
  );

  logger.info('AI verification complete', {
    projectId,
    co2e: result.co2eEstimated,
    confidence: result.confidence.overall,
    grade: result.grade,
    fraudRisk: result.fraud.risk,
  });

  return result;
}
