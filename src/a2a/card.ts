import type { AgentCard } from './types.js'

// Checks a card against the A2A v1.0 AgentCard fields pai relies on (the
// proto's REQUIRED fields, and the shape of the optional ones it models).
// Returns one message per problem; an empty list means the card is valid.
// Fields pai doesn't model are allowed.
export function validateCard (card: unknown): string[] {
  const errors: string[] = []
  if (!isObject(card)) return ['card must be an object']

  for (const field of ['name', 'description', 'version'] as const) {
    if (!isText(card[field])) errors.push(`${field} must be a non-empty string`)
  }
  for (const field of ['documentationUrl', 'iconUrl'] as const) {
    if (card[field] !== undefined && !isUrl(card[field])) errors.push(`${field} must be a valid URL`)
  }

  if (!Array.isArray(card.supportedInterfaces) || card.supportedInterfaces.length === 0) {
    errors.push('supportedInterfaces must be a non-empty array')
  } else {
    card.supportedInterfaces.forEach((iface: unknown, i: number) => {
      const at = `supportedInterfaces[${i}]`
      if (!isObject(iface)) {
        errors.push(`${at} must be an object`)
        return
      }
      if (!isUrl(iface.url)) errors.push(`${at}.url must be a valid URL`)
      for (const field of ['protocolBinding', 'protocolVersion']) {
        if (!isText(iface[field])) errors.push(`${at}.${field} must be a non-empty string`)
      }
      if (iface.tenant !== undefined && typeof iface.tenant !== 'string') errors.push(`${at}.tenant must be a string`)
    })
  }

  if (card.provider !== undefined) {
    if (!isObject(card.provider) || !isUrl(card.provider.url) || !isText(card.provider.organization)) {
      errors.push('provider must have a valid url and a non-empty organization')
    }
  }

  if (!isObject(card.capabilities)) {
    errors.push('capabilities must be an object')
  } else {
    for (const flag of ['streaming', 'pushNotifications', 'extendedAgentCard']) {
      const v = card.capabilities[flag]
      if (v !== undefined && typeof v !== 'boolean') errors.push(`capabilities.${flag} must be a boolean`)
    }
    const extensions = card.capabilities.extensions
    if (extensions !== undefined) {
      if (!Array.isArray(extensions)) errors.push('capabilities.extensions must be an array')
      else {
        extensions.forEach((ext: unknown, i: number) => {
          if (!isObject(ext) || !isText(ext.uri)) errors.push(`capabilities.extensions[${i}].uri must be a non-empty string`)
        })
      }
    }
  }

  if (card.securitySchemes !== undefined && !isObject(card.securitySchemes)) errors.push('securitySchemes must be an object')
  if (card.securityRequirements !== undefined && !Array.isArray(card.securityRequirements)) errors.push('securityRequirements must be an array')
  if (card.signatures !== undefined && !Array.isArray(card.signatures)) errors.push('signatures must be an array')

  for (const field of ['defaultInputModes', 'defaultOutputModes']) {
    if (!isStrings(card[field]) || card[field].length === 0) errors.push(`${field} must be a non-empty array of strings`)
  }

  if (!Array.isArray(card.skills) || card.skills.length === 0) {
    errors.push('skills must be a non-empty array')
  } else {
    card.skills.forEach((skill: unknown, i: number) => {
      const at = `skills[${i}]`
      if (!isObject(skill)) {
        errors.push(`${at} must be an object`)
        return
      }
      for (const field of ['id', 'name', 'description']) {
        if (!isText(skill[field])) errors.push(`${at}.${field} must be a non-empty string`)
      }
      if (!isStrings(skill.tags) || skill.tags.length === 0) errors.push(`${at}.tags must be a non-empty array of strings`)
      for (const field of ['examples', 'inputModes', 'outputModes']) {
        if (skill[field] !== undefined && !isStrings(skill[field])) errors.push(`${at}.${field} must be an array of strings`)
      }
    })
  }
  return errors
}

export function isValidCard (card: unknown): card is AgentCard {
  return validateCard(card).length === 0
}

function isObject (v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isText (v: unknown): v is string {
  return typeof v === 'string' && v !== ''
}

function isUrl (v: unknown): boolean {
  return typeof v === 'string' && URL.canParse(v)
}

function isStrings (v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string')
}
