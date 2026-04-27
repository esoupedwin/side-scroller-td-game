const NAMES: readonly string[] = [
  // English / American (10)
  'Jack', 'Kate', 'Sam', 'Tom', 'Lily', 'Grace', 'James', 'Cora', 'Finn', 'Ivy',
  // French (5)
  'Pierre', 'Claire', 'Jules', 'Renee', 'Claude',
  // German (5)
  'Hans', 'Greta', 'Klaus', 'Fritz', 'Bruno',
  // Spanish / Latin American (10)
  'Pedro', 'Ana', 'Diego', 'Luna', 'Carlos', 'Rosa', 'Felipe', 'Rodrigo', 'Mateo', 'Andres',
  // Italian (8)
  'Marco', 'Sofia', 'Luca', 'Giulia', 'Enzo', 'Bianca', 'Dante', 'Matteo',
  // Japanese (6)
  'Kenji', 'Yuki', 'Hana', 'Ryu', 'Kaito', 'Nana',
  // Korean (5)
  'Jin', 'Hyun', 'Soo', 'Min', 'Jae',
  // Chinese (4)
  'Wei', 'Mei', 'Lin', 'Chen',
  // Russian (8)
  'Ivan', 'Natasha', 'Boris', 'Olga', 'Sasha', 'Vera', 'Dmitri', 'Katya',
  // Arabic (8)
  'Omar', 'Layla', 'Hassan', 'Zara', 'Malik', 'Tariq', 'Amir', 'Nadia',
  // Indian (9)
  'Arjun', 'Priya', 'Raj', 'Deepa', 'Amit', 'Vikram', 'Suresh', 'Rani', 'Kiran',
  // African (8)
  'Kofi', 'Amara', 'Zuri', 'Chidi', 'Ade', 'Nia', 'Emeka', 'Kojo',
  // Nordic / Scandinavian (8)
  'Erik', 'Freya', 'Bjorn', 'Astrid', 'Leif', 'Sigrid', 'Gunnar', 'Ragnar',
  // City / place names used as names (6)
  'Paris', 'Milan', 'Cairo', 'Oslo', 'Kyoto', 'Lagos',
];

export function pickName(): string {
  return NAMES[Math.floor(Math.random() * NAMES.length)];
}
