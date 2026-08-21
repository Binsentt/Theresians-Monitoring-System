# Per-Question Client Bundle Review

> Local review artifact only. It does not connect to Railway, write PostgreSQL, publish, or import questions.

## Snapshot and normalization

- Bundle: `capstone-theresians-quest/Questions`
- Production fingerprint snapshot: Read-only PostgreSQL fingerprint snapshot (25 fingerprints)
- Captured at: 2026-08-21
- Snapshot scope: All 25 current public.questions rows, verified by read-only count query.
- Difficulty/location: Easy → Oakleaf Village; Normal/Medium → City of Knowledge; Difficult/Hard → Pinehill Village.
- A future importer may consume only entries with `status: CONFIRMED` and a controlled `confirmed_topic`; it must not infer a topic during apply.

## Status totals

| Confirmed | Needs Manual Confirmation | Already Represented | Duplicate | Malformed |
| ---: | ---: | ---: | ---: | ---: |
| 41 | 2 | 25 | 6 | 13 |

## Grade × Difficulty coverage matrix

Cell legend: C = Confirmed, M = Needs Manual Confirmation, R = Already Represented, D = Duplicate, X = Malformed.

| Grade | Easy — Oakleaf Village | Medium — City of Knowledge | Hard — Pinehill Village |
| --- | --- | --- | --- |
| Grade 1 | C 10 / M 1 / R 0 / D 6 / X 0 | C 4 / M 1 / R 0 / D 0 / X 0 | C 0 / M 0 / R 5 / D 0 / X 0 |
| Grade 2 | C 5 / M 0 / R 0 / D 0 / X 0 | C 4 / M 0 / R 0 / D 0 / X 1 | C 5 / M 0 / R 0 / D 0 / X 0 |
| Grade 3 | C 5 / M 0 / R 0 / D 0 / X 0 | C 5 / M 0 / R 0 / D 0 / X 0 | C 0 / M 0 / R 5 / D 0 / X 0 |
| Grade 4 | C 0 / M 0 / R 0 / D 0 / X 1 | C 0 / M 0 / R 5 / D 0 / X 0 | C 0 / M 0 / R 5 / D 0 / X 0 |
| Grade 5 | C 0 / M 0 / R 0 / D 0 / X 1 | C 0 / M 0 / R 0 / D 0 / X 1 | C 0 / M 0 / R 0 / D 0 / X 1 |
| Grade 6 | C 3 / M 0 / R 0 / D 0 / X 1 | C 0 / M 0 / R 5 / D 0 / X 0 | C 0 / M 0 / R 0 / D 0 / X 1 |

## Questions requiring manual topic decision

| Source | # | Grade | Difficulty | Location | Question | Controlled topic options | Reason |
| --- | ---: | --- | --- | --- | --- | --- | --- |
| grade 1/Normal/average.docx | 4 | Grade 1 | Medium | City of Knowledge | How many days are there in a week? | Addition; Multiplication; Word Problems | Source topic "Addition, Multiplication, and Word Problems" is not one controlled topic for this Grade and Difficulty. |
| grade_1_easy.json | 6 | Grade 1 | Easy | Oakleaf Village | Which number comes after 8? | Basic Addition; Subtraction; Shapes; Place Value | No explicit or uniquely determined controlled topic is available for this question. |

## Prospective groups from confirmed questions only

| Grade | Difficulty | Location | Confirmed topic | Questions |
| --- | --- | --- | --- | ---: |
| Grade 1 | Easy | Oakleaf Village | Basic Addition | 4 |
| Grade 1 | Easy | Oakleaf Village | Place Value | 1 |
| Grade 1 | Easy | Oakleaf Village | Shapes | 1 |
| Grade 1 | Easy | Oakleaf Village | Subtraction | 4 |
| Grade 1 | Medium | City of Knowledge | Addition | 2 |
| Grade 1 | Medium | City of Knowledge | Multiplication | 1 |
| Grade 1 | Medium | City of Knowledge | Word Problems | 1 |
| Grade 2 | Easy | Oakleaf Village | Basic Addition/Subtraction | 3 |
| Grade 2 | Easy | Oakleaf Village | Ordinal Numbers | 1 |
| Grade 2 | Easy | Oakleaf Village | Shapes | 1 |
| Grade 2 | Hard | Pinehill Village | Division | 1 |
| Grade 2 | Hard | Pinehill Village | Fractions | 1 |
| Grade 2 | Hard | Pinehill Village | Multiplication | 1 |
| Grade 2 | Hard | Pinehill Village | Problem Solving | 2 |
| Grade 2 | Medium | City of Knowledge | Division | 1 |
| Grade 2 | Medium | City of Knowledge | Multiplication | 2 |
| Grade 2 | Medium | City of Knowledge | Word Problems | 1 |
| Grade 3 | Easy | Oakleaf Village | Addition of Money | 4 |
| Grade 3 | Easy | Oakleaf Village | Whole Numbers | 1 |
| Grade 3 | Medium | City of Knowledge | Division | 1 |
| Grade 3 | Medium | City of Knowledge | Fractions | 2 |
| Grade 3 | Medium | City of Knowledge | Multiplication | 2 |
| Grade 6 | Easy | Oakleaf Village | Number Sense and Operations | 3 |

## Full per-question review

### CONFIRMED

#### grade 1/Easy/easy.docx — question 1

- Stable fingerprint: `9b72820de80cd8cb7fc49b615031e9a2433123318d9a3dd8ccb2990b0e9a8b39`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Basic Addition
- Confirmed topic: Basic Addition
- Question: 5 + 2 = ?
- Choices: 8 | 7 | 6 | 9
- Correct answer: 7
- Reason: Direct addition expression.

#### grade 1/Easy/easy.docx — question 2

- Stable fingerprint: `6da9153287e9bf2b7dfe09769f641074efef5a0de05174ecaa24b0d4b3016554`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Shapes
- Confirmed topic: Shapes
- Question: How many sides does a triangle have?
- Choices: 4 | 3 | 5 | 2
- Correct answer: 3
- Reason: Direct geometric-shape question.

#### grade 1/Easy/easy.docx — question 3

- Stable fingerprint: `515d07c8843e818598452afc8860cb24f3f19da3d3349bfa9e93f5a16ae6e2aa`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Subtraction
- Confirmed topic: Subtraction
- Question: Anna has 8 candies. She gives 3 to her friend. How many are left?
- Choices: 5 | 11 | 6 | 4
- Correct answer: 5
- Reason: Direct remaining-quantity subtraction question.

#### grade 1/Easy/easy.docx — question 4

- Stable fingerprint: `ad0fadef4133a83cc96ec6e07c2d344032c045fc8faf1bd3ce79fc9ff2c39169`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Subtraction
- Confirmed topic: Subtraction
- Question: 18 − 9 = ?
- Choices: 9 | 13 | 8 | 10
- Correct answer: 9
- Reason: Direct subtraction expression.

#### grade 1/Easy/easy.docx — question 5

- Stable fingerprint: `2f056cc5a04d0f1aa8780ac3dbe00c5774e658eba808dee02a2c64878c6fc419`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Place Value
- Confirmed topic: Place Value
- Question: What is the place value of 3 in 34?
- Choices: Ones | Tens | Hundreds | Thousands
- Correct answer: Tens
- Reason: Direct place-value question.

#### grade 1/Normal/average.docx — question 1

- Stable fingerprint: `babc98d97c6c4c2cc2e5c6ae4eb435cae4a42a0a41a1f9c62b92742922162656`
- Grade / difficulty / location: Grade 1 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: Addition
- Confirmed topic: Addition
- Question: There are 16 boys and 8 girls. How many pupils are there in all?
- Choices: 24 | 56 | 30 | 66
- Correct answer: 24
- Reason: Direct combined-total addition question.

#### grade 1/Normal/average.docx — question 2

- Stable fingerprint: `207d8ca37d3f424a53445f843346aecf9f3138df20a8fcd387c59e5920e6558f`
- Grade / difficulty / location: Grade 1 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: Multiplication
- Confirmed topic: Multiplication
- Question: 5 × 5 = ?
- Choices: 25 | 15 | 42 | 20
- Correct answer: 25
- Reason: Direct multiplication expression.

#### grade 1/Normal/average.docx — question 3

- Stable fingerprint: `546626963d8d6ef33d94d398294e45839edec4af38323ca6ddc827fed3dc2297`
- Grade / difficulty / location: Grade 1 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: Word Problems
- Confirmed topic: Word Problems
- Question: Sam grew 23 roses. She picked 13. How many are left?
- Choices: 10 | 15 | 13 | 18
- Correct answer: 10
- Reason: Single-operation narrative not represented by the other Grade 1 Medium controlled topics.

#### grade 1/Normal/average.docx — question 5

- Stable fingerprint: `488ca84d7d2922bc322698c96828db0139ed845483262df73b7c6da02ba96be9`
- Grade / difficulty / location: Grade 1 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: Addition
- Confirmed topic: Addition
- Question: A farmer has 9 ducks and 6 chickens. How many animals in all?
- Choices: 13 | 15 | 14 | 16
- Correct answer: 15
- Reason: Direct combined-total addition question.

#### grade 2/Difficult/difficult.docx — question 1

- Stable fingerprint: `a549406c5b44802efe0a263653c7705c97d53b528405e32f2765e25c72298434`
- Grade / difficulty / location: Grade 2 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: Multiplication
- Confirmed topic: Multiplication
- Question: There are 8 players in a game. If each player made 6 kicks, how many kicks were made in total?
- Choices: 42 | 48 | 54 | 56
- Correct answer: 48
- Reason: Equal groups with a total requested.

#### grade 2/Difficult/difficult.docx — question 2

- Stable fingerprint: `a9a52a0aa33f00d669d0ad5430bad9832aec385a1af3af9c6187b005bde0c098`
- Grade / difficulty / location: Grade 2 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: Division
- Confirmed topic: Division
- Question: A father has 64 candies to share equally among his 8 sons. How many candies will each son receive?
- Choices: 6 | 7 | 8 | 9
- Correct answer: 8
- Reason: Equal-sharing division question.

#### grade 2/Difficult/difficult.docx — question 3

- Stable fingerprint: `f352dab9a81b693383e7695ce1549080ca5fe0552203a33ab95b65700c910875`
- Grade / difficulty / location: Grade 2 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: Problem Solving
- Confirmed topic: Problem Solving
- Question: A sports shop has 726 small jerseys and 217 large jerseys. How many more small jerseys are there than large ones?
- Choices: 509 | 511 | 519 | 609
- Correct answer: 511
- Reason: Narrative comparison problem within the Grade 2 Hard controlled vocabulary.

#### grade 2/Difficult/difficult.docx — question 4

- Stable fingerprint: `00a596932e70187e7cf17ae8045985490af630e6017dd19eb053265091b11a54`
- Grade / difficulty / location: Grade 2 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: Problem Solving
- Confirmed topic: Problem Solving
- Question: A collector had 980 stickers. After giving away 762 stickers to friends, how many stickers are left?
- Choices: 218 | 222 | 228 | 238
- Correct answer: 218
- Reason: Narrative remaining-quantity problem within the Grade 2 Hard controlled vocabulary.

#### grade 2/Difficult/difficult.docx — question 5

- Stable fingerprint: `34834761441cfeeef56a25e92e63c374ffc064a20b7f405259eb3cb75f96676b`
- Grade / difficulty / location: Grade 2 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: Fractions
- Confirmed topic: Fractions
- Question: In a class of 18 students, 13 are girls. What fraction of the students are boys?
- Choices: $5/13$ | $13/18$ | $5/18$ | $8/18$
- Correct answer: $5/18$
- Reason: Direct fraction-of-a-set question.

#### grade 2/Easy/easy.docx — question 1

- Stable fingerprint: `778f5034884a04dcad119a5ccc8c2f969ac4ebbcb82dcc4ff232b278b96bb821`
- Grade / difficulty / location: Grade 2 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Shapes
- Confirmed topic: Shapes
- Question: What shape has 4 equal sides?
- Choices: Rectangle | Square | Triangle | Circle
- Correct answer: Square
- Reason: Direct geometric-shape question.

#### grade 2/Easy/easy.docx — question 2

- Stable fingerprint: `116d63bd4550dfbb5638ffcf2612e8cd3717d77b3e2fee9c9e728c65002362ca`
- Grade / difficulty / location: Grade 2 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Ordinal Numbers
- Confirmed topic: Ordinal Numbers
- Question: What is the ordinal number of the last month of the year?
- Choices: 9th | 12th | 10th | 11th
- Correct answer: 12th
- Reason: Direct ordinal-number question.

#### grade 2/Easy/easy.docx — question 3

- Stable fingerprint: `5669ad09bb01843ad296fcff0f48d5aa67c8ac71fd760f240eac3c6e87e061ac`
- Grade / difficulty / location: Grade 2 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Basic Addition/Subtraction
- Confirmed topic: Basic Addition/Subtraction
- Question: Jenny has 56 candies. Chloe has 94. How many do they have together?
- Choices: 150 | 190 | 140 | 130
- Correct answer: 150
- Reason: Direct combined-total arithmetic question.

#### grade 2/Easy/easy.docx — question 4

- Stable fingerprint: `c2ba0478379d8b7330dd31316e338f5136e2d98090ba29e66635b5fd081939d1`
- Grade / difficulty / location: Grade 2 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Basic Addition/Subtraction
- Confirmed topic: Basic Addition/Subtraction
- Question: There are 437 girls and 325 boys. How many more girls than boys?
- Choices: 112 | 132 | 102 | 120
- Correct answer: 112
- Reason: Direct comparison subtraction question.

#### grade 2/Easy/easy.docx — question 5

- Stable fingerprint: `bce5937dd7fa7cd7fb1cd0c4f676edf2fb36daa421769117677af2256801e069`
- Grade / difficulty / location: Grade 2 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Basic Addition/Subtraction
- Confirmed topic: Basic Addition/Subtraction
- Question: Nikolai received ₱89.00 and ₱30.00. How much does he have in total?
- Choices: ₱109.00 | ₱119.00 | ₱129.00 | ₱99.00
- Correct answer: ₱119.00
- Reason: Direct combined-total arithmetic question.

#### grade 2/Normal/average.docx — question 1

- Stable fingerprint: `8d1285a089e564da68f8fcc6e9c39c30eaf1cda626ed04e43fc39fb211874fbc`
- Grade / difficulty / location: Grade 2 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: Multiplication
- Confirmed topic: Multiplication
- Question: What is the sum of 2 nines and 6 fives?
- Choices: 48 | 56 | 58 | 66
- Correct answer: 48
- Reason: Repeated-number groups expressed as a sum.

#### grade 2/Normal/average.docx — question 2

- Stable fingerprint: `1e9f9cbf884a64960b5f8ac0f4639fcb596fd40237c85f311a7a3eb38ccf1593`
- Grade / difficulty / location: Grade 2 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: Multiplication
- Confirmed topic: Multiplication
- Question: There are 18 boxes with 7 pins each. How many pins in all?
- Choices: 126 | 136 | 146 | 156
- Correct answer: 126
- Reason: Equal groups with a total requested.

#### grade 2/Normal/average.docx — question 3

- Stable fingerprint: `2e40bf734213612011cadbc5895c7f8e0a1e16716a5d8edffb7be4d19790a74a`
- Grade / difficulty / location: Grade 2 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: Word Problems
- Confirmed topic: Word Problems
- Question: Sam grew 543 roses. She picked 147. How many are left?
- Choices: 396 | 584 | 690 | 706
- Correct answer: 396
- Reason: Single-operation narrative not represented by the other Grade 2 Medium controlled topics.

#### grade 2/Normal/average.docx — question 4

- Stable fingerprint: `a56e94c9e4f21cf1cb4cbccdc400b63f8c39718fd8ee5cce0a0346708d5ee512`
- Grade / difficulty / location: Grade 2 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: Division
- Confirmed topic: Division
- Question: There are 42 days. How many weeks is that?
- Choices: 6 | 7 | 8 | 9
- Correct answer: 6
- Reason: Direct equal-group division question.

#### grade 3/Easy/easy.docx — question 1

- Stable fingerprint: `23f7fb61ff8098b87a3158ea8c1a478af96669b85f94956d2657b4b6b1e66640`
- Grade / difficulty / location: Grade 3 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Addition of Money
- Confirmed topic: Addition of Money
- Question: Last Christmas, Joseph received ₱598.00 from his uncle Lito and ₱523.00 from his uncle John. How much money does he have?
- Choices: ₱1,321 | ₱1,121 | ₱1,021 | ₱1,221
- Correct answer: ₱1,121
- Reason: Direct monetary addition question.

#### grade 3/Easy/easy.docx — question 2

- Stable fingerprint: `514fe08c2f910c157d27f2546e7cca9df2e43787f370e335a669f530eb18d047`
- Grade / difficulty / location: Grade 3 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Addition of Money
- Confirmed topic: Addition of Money
- Question: Rodel bought 12 goldfish that cost ₱3,000.00 and 10 packages of fish food that cost ₱1,567.00. How much money did he spend?
- Choices: ₱3,568 | ₱4,567 | ₱4,657 | ₱3,658
- Correct answer: ₱4,567
- Reason: Direct monetary total question.

#### grade 3/Easy/easy.docx — question 3

- Stable fingerprint: `f4fd6cbf8b241f3e573f876cedb5dbeac5ba3a891c4a05c64e62f5a964ad4733`
- Grade / difficulty / location: Grade 3 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Addition of Money
- Confirmed topic: Addition of Money
- Question: Nikolai’s father gave him ₱89.00 and his mother gave him ₱30.00. How much money does he have combined?
- Choices: ₱109.00 | ₱119.00 | ₱129.00 | ₱139.00
- Correct answer: ₱119.00
- Reason: Direct monetary addition question.

#### grade 3/Easy/easy.docx — question 4

- Stable fingerprint: `cc7a41b7b7bec8cf5253e04c566e4804d5845ef9e4f65c4cfecd5de49b5cd07e`
- Grade / difficulty / location: Grade 3 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Addition of Money
- Confirmed topic: Addition of Money
- Question: Shean received ₱100.00 from his godmother and ₱500.00 from his godfather. How much money does he have?
- Choices: ₱600.00 | ₱700.00 | ₱400.00 | ₱800.00
- Correct answer: ₱600.00
- Reason: Direct monetary addition question.

#### grade 3/Easy/easy.docx — question 5

- Stable fingerprint: `22ac7ee53a60eeac20581a05d92a824aee99657edadd7518e7c74b8b75bba493`
- Grade / difficulty / location: Grade 3 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Whole Numbers
- Confirmed topic: Whole Numbers
- Question: Jenny has 56 candies. Chloe has 94. How many candies do they have together?
- Choices: 150 | 160 | 140 | 170
- Correct answer: 150
- Reason: Whole-number addition with no monetary unit.

#### grade 3/Normal/average.docx — question 1

- Stable fingerprint: `17846a58bd6b852ba2eeaf8b625bc4b4b68ac0c466b1d3e3aa39edea58e3876e`
- Grade / difficulty / location: Grade 3 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: Multiplication
- Confirmed topic: Multiplication
- Question: Average Round What is the sum of 5 eights and 2 sixes?
- Choices: 52 | 72 | 82 | 92
- Correct answer: 52
- Reason: Repeated groups expressed as multiples.

#### grade 3/Normal/average.docx — question 2

- Stable fingerprint: `26b281c920d0dcd390e6ab9e6e2717b250916da39c3fa4ffda646997fddc1f8e`
- Grade / difficulty / location: Grade 3 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: Multiplication
- Confirmed topic: Multiplication
- Question: There are 5 pencil holders and each pencil holder has 9 pencils. How many pencils are there in all?
- Choices: 15 | 35 | 45 | 65
- Correct answer: 45
- Reason: Equal groups with a total requested.

#### grade 3/Normal/average.docx — question 3

- Stable fingerprint: `691fde9e3780b14eeafb080188b5e2e4bd5ccbd1f5316352ef338111e9710948`
- Grade / difficulty / location: Grade 3 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: Division
- Confirmed topic: Division
- Question: Mr. Jimmy has 360 stamps. If each envelope contains 12 stamps, how many envelopes does he use?
- Choices: 20 | 30 | 40 | 60
- Correct answer: 30
- Reason: Equal-group division question.

#### grade 3/Normal/average.docx — question 4

- Stable fingerprint: `ef9ecc5f2121454d6c5643f8869cee3dd3a2026a8b87b4025c486381a880b996`
- Grade / difficulty / location: Grade 3 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: Fractions
- Confirmed topic: Fractions
- Question: What is the mixed fraction symbol of 32/3?
- Choices: 8 2/3 | 9 2/3 | 10 2/3 | 11 5/3
- Correct answer: 10 2/3
- Reason: Direct mixed-fraction question.

#### grade 3/Normal/average.docx — question 5

- Stable fingerprint: `707ad4730bcdc8a3ed87814963cd919fbab08d5f340684f2cd2eac700e6ad030`
- Grade / difficulty / location: Grade 3 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: Fractions
- Confirmed topic: Fractions
- Question: What is the mixed fraction symbol of 21/4?
- Choices: 5 1/4 | 6 2/4 | 7 2/3 | 8 5/4
- Correct answer: 5 1/4
- Reason: Direct mixed-fraction question.

#### grade 6/Easy/easy.docx — question 1

- Stable fingerprint: `dac66bd3f18997024da375fe4a7087af057f68863477e96ae430a9342239a1cc`
- Grade / difficulty / location: Grade 6 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Number Sense and Operations
- Confirmed topic: Number Sense and Operations
- Question: When writing a whole number as a fraction, what should its denominator be?
- Choices: 4 | 5 | 2 | 1
- Correct answer: 1
- Reason: An explicit controlled topic header applies to this source.

#### grade 6/Easy/easy.docx — question 2

- Stable fingerprint: `f0a5947fd2d0563ec207784ed9b5bf8d9bd6ff4fe64e9b6e5acd04c7c97e893b`
- Grade / difficulty / location: Grade 6 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Number Sense and Operations
- Confirmed topic: Number Sense and Operations
- Question: In dividing fractions, you’ll need to get the _______ of the given divisor before you multiply the numerators and the denominators.
- Choices: LCD | Simplified Form | Reciprocal | None of the above Answer: | Reciprocal | 6 | 16 | –6 | 55
- Correct answer: Simplified Form
- Reason: An explicit controlled topic header applies to this source.

#### grade 6/Easy/easy.docx — question 3

- Stable fingerprint: `f42e92274432bb91ec706ade279efe1d30bd75eec5c5bd25c7afbd74e180aa9c`
- Grade / difficulty / location: Grade 6 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Number Sense and Operations
- Confirmed topic: Number Sense and Operations
- Question: What is 10% of 350?
- Choices: 3.5 | 35 | 70 | 315
- Correct answer: 35
- Reason: An explicit controlled topic header applies to this source.

#### grade_1_easy.json — question 1

- Stable fingerprint: `f2c037bc6216ed6d823be0302cb3d928a0564214218c89ee31d5f200b3b6901f`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Basic Addition
- Confirmed topic: Basic Addition
- Question: 2 + 2 = ?
- Choices: 3 | 4 | 5
- Correct answer: 4
- Reason: Direct addition expression.

#### grade_1_easy.json — question 2

- Stable fingerprint: `67ef1c327bb38392e2dcd41aeebcb0d4b2300cb60d77d19769f3f71f3f982603`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Basic Addition
- Confirmed topic: Basic Addition
- Question: 1 + 3 = ?
- Choices: 2 | 4 | 5
- Correct answer: 4
- Reason: Direct addition expression.

#### grade_1_easy.json — question 3

- Stable fingerprint: `2189382d4388664e8caebbcde0b4336c690f142f130ccfddd14a438e7193f738`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Subtraction
- Confirmed topic: Subtraction
- Question: 5 - 2 = ?
- Choices: 2 | 3 | 4
- Correct answer: 3
- Reason: Direct subtraction expression.

#### grade_1_easy.json — question 4

- Stable fingerprint: `14ea10acf09377064c69d82f886ebcb25635d6e5f03441c656f0b442b228dbcb`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Basic Addition
- Confirmed topic: Basic Addition
- Question: 6 + 1 = ?
- Choices: 6 | 7 | 8
- Correct answer: 7
- Reason: Direct addition expression.

#### grade_1_easy.json — question 5

- Stable fingerprint: `bbe7bf9d740d1090474dc4f1338bf089a82fc661cc1e3ee41250f793f96afb84`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: Subtraction
- Confirmed topic: Subtraction
- Question: 4 - 1 = ?
- Choices: 2 | 3 | 4
- Correct answer: 3
- Reason: Direct subtraction expression.

### NEEDS MANUAL CONFIRMATION

#### grade 1/Normal/average.docx — question 4

- Stable fingerprint: `b7ad013852646f0c337df1dcd384f73bd7bf201dff4c9e5a0dae00c4f992014d`
- Grade / difficulty / location: Grade 1 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: None
- Confirmed topic: None
- Question: How many days are there in a week?
- Choices: 7 | 9 | 8 | 10
- Correct answer: 7
- Reason: Source topic "Addition, Multiplication, and Word Problems" is not one controlled topic for this Grade and Difficulty.

#### grade_1_easy.json — question 6

- Stable fingerprint: `5a99e2f5c444ed6dda97fb4184b679091612e1b2375318714870af52f5df6e4b`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: None
- Confirmed topic: None
- Question: Which number comes after 8?
- Choices: 7 | 9 | 10
- Correct answer: 9
- Reason: No explicit or uniquely determined controlled topic is available for this question.

### ALREADY REPRESENTED

#### grade 1/Difficult/DIFFICULT.docx — question 1

- Stable fingerprint: `6af1ff8d04de5064f228a99a9b691f4e9d1069285e2d2d74f2d3d197f599e086`
- Grade / difficulty / location: Grade 1 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: A box has 35 cookies. 17 were eaten. How many remain?
- Choices: 18 | 20 | 15 | 22
- Correct answer: 18
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 8

#### grade 1/Difficult/DIFFICULT.docx — question 2

- Stable fingerprint: `dff034bc7a69c8617bd6b993b25dc681b1d11595b116f9e9f6639f0793b536b3`
- Grade / difficulty / location: Grade 1 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: Mark has 18 marbles. His brother gave him 7 more. How many does he have now?
- Choices: 24 | 25 | 23 | 26
- Correct answer: 25
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 8

#### grade 1/Difficult/DIFFICULT.docx — question 3

- Stable fingerprint: `45a45d3a764409bbf210746583d7c9b9f507386b56ae96a8b564d98ed0250fe7`
- Grade / difficulty / location: Grade 1 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: A farmer picked 18 mangoes in the morning and 24 in the afternoon. How many in all?
- Choices: 40 | 42 | 41 | 44
- Correct answer: 42
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 8

#### grade 1/Difficult/DIFFICULT.docx — question 4

- Stable fingerprint: `96f65b4477405ccb7343ed7e3dd171cbdf2c6f57b0513b18ff33c423c99e2057`
- Grade / difficulty / location: Grade 1 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: There are 28 fish. 9 were transferred. How many are left?
- Choices: 18 | 17 | 19 | 20
- Correct answer: 19
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 8

#### grade 1/Difficult/DIFFICULT.docx — question 5

- Stable fingerprint: `f9a28882307b73354a9b0ea3edb347dd383815f49163008e1ed1ee359f41376a`
- Grade / difficulty / location: Grade 1 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: Maria has 36 stickers. Her sister gave her 14 more. How many now?
- Choices: 48 | 50 | 49 | 52
- Correct answer: 50
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 8

#### grade 3/Difficult/difficult.docx — question 1

- Stable fingerprint: `87054994e39e5deb9582258573e908c671298dc6a3fb687b9eb6602144e7a69f`
- Grade / difficulty / location: Grade 3 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: Betty has 144 pieces of apples. She sells them equally to her 6 loyal buyers. How many apples did each buyer buy?
- Choices: 20 apples | 24 apples | 26 apples | 30 apples
- Correct answer: 24 apples
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 9

#### grade 3/Difficult/difficult.docx — question 2

- Stable fingerprint: `ce4d72f62e26e72893346d84da8d922be0b549862234646d9dc91f49cc1565c6`
- Grade / difficulty / location: Grade 3 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: Coach Macky ordered 728 small jerseys and 217 large jerseys. How many more players wear small jerseys than large ones?
- Choices: 501 players | 511 players | 521 players | 611 players
- Correct answer: 511 players
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 9

#### grade 3/Difficult/difficult.docx — question 3

- Stable fingerprint: `741b9d9aa70b38823bec363b41b86569b23d29ea16a6d991458d32ec300d5fc3`
- Grade / difficulty / location: Grade 3 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: There are 982 stickers in a book. If the teacher gave 762 of the stickers to students, how many stickers were left?
- Choices: 200 stickers | 210 stickers | 220 stickers | 230 stickers
- Correct answer: 220 stickers
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 9

#### grade 3/Difficult/difficult.docx — question 4

- Stable fingerprint: `5410832b6bd71c8557f146c75ffea71326ed85b3684ffe7a4b7518a996d6dc41`
- Grade / difficulty / location: Grade 3 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: Coach Macky has 15 players and ordered t-shirts that cost ₱556 each. How much did Coach Macky spend?
- Choices: ₱8,240 | ₱8,340 | ₱8,440 | ₱8,540
- Correct answer: ₱8,340
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 9

#### grade 3/Difficult/difficult.docx — question 5

- Stable fingerprint: `3c495aaec7ffe165f9d857293d402fcaaa5360a0c6239f228ccae4e08e270f5e`
- Grade / difficulty / location: Grade 3 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: Mrs. July bought 64 pieces of Lollipops and gave them to her 8 grandchildren equally. How many Lollipops does each grandchild get?
- Choices: 6 pieces | 7 pieces | 8 pieces | 9 pieces
- Correct answer: 8 pieces
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 9

#### grade 4/Difficult/difficult.docx — question 1

- Stable fingerprint: `12a0224c3fa820c58dd39b1f1d3b61eda2e4d5b1021cb20f0a36ee96758266d6`
- Grade / difficulty / location: Grade 4 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: The number word for 78,020 is ________.
- Choices: seven eight thousand, twenty | seventy-eight thousand, twenty | seventy-eight thousand, two hundred | seventy-eight thousand, two
- Correct answer: seventy-eight thousand, twenty
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 10

#### grade 4/Difficult/difficult.docx — question 2

- Stable fingerprint: `6798602329bc196c37026fde339c94f9eb486b4530730e28b5d23b9a0127a10c`
- Grade / difficulty / location: Grade 4 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: The number symbol for ninety-nine thousand, twelve is ________.
- Choices: 99 012 | 909 012 | 99 102 | 99 021
- Correct answer: 99 012
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 10

#### grade 4/Difficult/difficult.docx — question 3

- Stable fingerprint: `11eb4402a9c50a5968f0b6dcf71f48f87bf504ccb063a0775427a81bfbf38395`
- Grade / difficulty / location: Grade 4 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: What symbol should be used to make the equation correct?23 000 ______ 23 006
- Choices: < | > | = | ≠
- Correct answer: <
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 10

#### grade 4/Difficult/difficult.docx — question 4

- Stable fingerprint: `4aec7128dd33dfb7f662a086e66f0fb60752a843845fbd02f821c9d9025896e4`
- Grade / difficulty / location: Grade 4 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: Which statement is correct?
- Choices: 5 000 > 5 326 | 5 120 = 5 623 | 5 328 > 5 303 | 5 934 < 4 205
- Correct answer: 5 328 > 5 303
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 10

#### grade 4/Difficult/difficult.docx — question 5

- Stable fingerprint: `f8281a26b848d09130382788f387103497d37da92a86d51871fda8072eabac60`
- Grade / difficulty / location: Grade 4 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: The number 89,098 is read as ________.
- Choices: eighty-nine thousand, nine hundred eight | ninety-eight thousand, ninety-eight | eighty-nine thousand, nine hundred eight | eighty-nine thousand, ninety-eight
- Correct answer: eighty-nine thousand, ninety-eight
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 10

#### grade 4/Normal/average.docx — question 1

- Stable fingerprint: `e199bb92b41857a75d9264820a37910c6c7febb580a1ca5b7196dc17306c310d`
- Grade / difficulty / location: Grade 4 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: None
- Confirmed topic: None
- Question: What number is 10,000 less than 31,211?
- Choices: 21,200 | 21,211 | 21,210 | 21,201
- Correct answer: 21,211
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 11

#### grade 4/Normal/average.docx — question 2

- Stable fingerprint: `c45cc8313345422377f193b7459de5d0c10ad8a27669a79f0b45a1923d198ef8`
- Grade / difficulty / location: Grade 4 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: None
- Confirmed topic: None
- Question: What number is represented by these discs?
- Choices: 1,500 | 1,005 | 1,050 | 1,006
- Correct answer: 1,005
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 11

#### grade 4/Normal/average.docx — question 3

- Stable fingerprint: `afbcff06985c902a90554a221132ab7804f3901e487c857b5b4ed5e95d67c034`
- Grade / difficulty / location: Grade 4 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: None
- Confirmed topic: None
- Question: What number has 5 ten thousands, 6 thousands, 7 hundreds, 4 tens and 8 ones?
- Choices: 54 679 | 56 478 | 56 748 | 57 648
- Correct answer: 56 748
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 11

#### grade 4/Normal/average.docx — question 4

- Stable fingerprint: `4c4de83a412907af33cee353054a36a090566d91f8acac43ec1ccc9a457e9ef9`
- Grade / difficulty / location: Grade 4 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: None
- Confirmed topic: None
- Question: Encircle the letter of the number with a 5 in the thousands place.
- Choices: 45 304 | 51 760 | 76 542 | 93 227
- Correct answer: 45 304
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 11

#### grade 4/Normal/average.docx — question 5

- Stable fingerprint: `d034febe604e8f2190eb116b947c9c7c73a8eb7090e5744fb40b6077a147abd2`
- Grade / difficulty / location: Grade 4 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: None
- Confirmed topic: None
- Question: In 92 165, give the value of the digit in the ten thousands place.
- Choices: 20 000 | 50 000 | 60 000 | 90 000
- Correct answer: 90 000
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 11

#### grade 6/Normal/average.docx — question 1

- Stable fingerprint: `0a20ada0e4298839f7d1f3685151372368d82bd6c6e346afd77f5a874a9a137d`
- Grade / difficulty / location: Grade 6 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: None
- Confirmed topic: None
- Question: Average: Topic: Number Sense and Operations Which is the largest fraction?
- Choices: 7/8 | 13/15 | 17/20 | 5/6
- Correct answer: 17/20
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 12

#### grade 6/Normal/average.docx — question 2

- Stable fingerprint: `b1e7211092fae93a2d771ef1327e68388e11b36aa9c27278f0729b18d12b824d`
- Grade / difficulty / location: Grade 6 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: None
- Confirmed topic: None
- Question: If a = 3 and b = –2, evaluate the expression:
- Choices: 12 | 28 | 36 | 40 -
- Correct answer: 36
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 12

#### grade 6/Normal/average.docx — question 3

- Stable fingerprint: `09acc73526e16d8a3b180c8230dea6766d7578d7b0b5ae5a5f882a656f39f54a`
- Grade / difficulty / location: Grade 6 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: None
- Confirmed topic: None
- Question: Two dice are rolled. What is the probability that the sum of the numbers shown is 9?
- Choices: 1/6 | 1/9 | 1/12 | 4/9
- Correct answer: 1/6
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 12

#### grade 6/Normal/average.docx — question 4

- Stable fingerprint: `ff4ee1e8494a605fc3414f1565ba58f54fb398271ad22107b4186148fc57dfcd`
- Grade / difficulty / location: Grade 6 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: None
- Confirmed topic: None
- Question: If today is Monday, what day will it be in 100 days?
- Choices: Monday | Tuesday | Wednesday | Thursday
- Correct answer: Wednesday
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 12

#### grade 6/Normal/average.docx — question 5

- Stable fingerprint: `57ac561889557fbd7ac1a424632ca0fe7e0fae00ebcddb198ca9fb0046671b25`
- Grade / difficulty / location: Grade 6 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: None
- Confirmed topic: None
- Question: If 3x + 5 = 20, what is the value of x?
- Choices: 3 | 4 | 5 | 6
- Correct answer: 5
- Reason: A question with this stable content fingerprint is already represented in the read-only production snapshot.
- Production representation: learning_file_id 12

### DUPLICATE

#### Grade1/easy.json — question 1

- Stable fingerprint: `f2c037bc6216ed6d823be0302cb3d928a0564214218c89ee31d5f200b3b6901f`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: None
- Confirmed topic: None
- Question: 2 + 2 = ?
- Choices: 3 | 4 | 5
- Correct answer: 4
- Reason: An earlier bundled question has the same stable content fingerprint.
- Duplicate of: grade_1_easy.json question 1

#### Grade1/easy.json — question 2

- Stable fingerprint: `67ef1c327bb38392e2dcd41aeebcb0d4b2300cb60d77d19769f3f71f3f982603`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: None
- Confirmed topic: None
- Question: 1 + 3 = ?
- Choices: 2 | 4 | 5
- Correct answer: 4
- Reason: An earlier bundled question has the same stable content fingerprint.
- Duplicate of: grade_1_easy.json question 2

#### Grade1/easy.json — question 3

- Stable fingerprint: `2189382d4388664e8caebbcde0b4336c690f142f130ccfddd14a438e7193f738`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: None
- Confirmed topic: None
- Question: 5 - 2 = ?
- Choices: 2 | 3 | 4
- Correct answer: 3
- Reason: An earlier bundled question has the same stable content fingerprint.
- Duplicate of: grade_1_easy.json question 3

#### Grade1/easy.json — question 4

- Stable fingerprint: `14ea10acf09377064c69d82f886ebcb25635d6e5f03441c656f0b442b228dbcb`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: None
- Confirmed topic: None
- Question: 6 + 1 = ?
- Choices: 6 | 7 | 8
- Correct answer: 7
- Reason: An earlier bundled question has the same stable content fingerprint.
- Duplicate of: grade_1_easy.json question 4

#### Grade1/easy.json — question 5

- Stable fingerprint: `bbe7bf9d740d1090474dc4f1338bf089a82fc661cc1e3ee41250f793f96afb84`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: None
- Confirmed topic: None
- Question: 4 - 1 = ?
- Choices: 2 | 3 | 4
- Correct answer: 3
- Reason: An earlier bundled question has the same stable content fingerprint.
- Duplicate of: grade_1_easy.json question 5

#### Grade1/easy.json — question 6

- Stable fingerprint: `5a99e2f5c444ed6dda97fb4184b679091612e1b2375318714870af52f5df6e4b`
- Grade / difficulty / location: Grade 1 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: None
- Confirmed topic: None
- Question: Which number comes after 8?
- Choices: 7 | 9 | 10
- Correct answer: 9
- Reason: An earlier bundled question has the same stable content fingerprint.
- Duplicate of: grade_1_easy.json question 6

### MALFORMED

#### grade 1/boss question.docx — question 1

- Stable fingerprint: `613bab60172bdc6a7e7b2b4867d3c4db651c10a87ce23501dfa91d82346acaf0`
- Grade / difficulty / location: Grade 1 | Unknown | Unknown
- Original difficulty: Unknown
- Proposed topic: None
- Confirmed topic: None
- Question: A class collected 25 shells in the morning and 25 shells in the afternoon. On the way back to school, they accidentally dropped 12 shells. How many shells do they have left now? 25 38 50 62 Correct Answer: 38
- Choices: Unavailable
- Correct answer: Unavailable
- Reason: At least two choices are required.

#### grade 2/boss question.docx — question 1

- Stable fingerprint: `134de259aa77918aacc15accbbcf81ca0710bf658bd7686e9e81f839edb4bc38`
- Grade / difficulty / location: Grade 2 | Unknown | Unknown
- Original difficulty: Unknown
- Proposed topic: None
- Confirmed topic: None
- Question: Mrs. Emily bought a buko pie and sliced it into 8 equal pieces. Her daughter ate 2 slices, and her son ate 3 slices. What fraction of the total pie is left over for Mrs. Emily? sori di ma type ung  over
- Choices: Unavailable
- Correct answer: Unavailable
- Reason: At least two choices are required.

#### grade 2/Normal/average.docx — question 5

- Stable fingerprint: `923070ad399c6c57c50bd6ccde1324e4ced4517030a5773fec09afb5958e19b8`
- Grade / difficulty / location: Grade 2 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: None
- Confirmed topic: None
- Question: Gina bought 3 dozens of eggs. How many eggs is that?
- Choices: 26 | 36 | 46 | 56
- Correct answer: Unavailable
- Reason: Missing correct answer.

#### grade 3/boss question.docx — question 1

- Stable fingerprint: `045c331999a31d3d9032eeb248ebd15ade5e5b9f018bbc0a34b7dc7f2644db22`
- Grade / difficulty / location: Grade 3 | Unknown | Unknown
- Original difficulty: Unknown
- Proposed topic: None
- Confirmed topic: None
- Question: Mrs. July bought 64 pieces of Lollipops and shared them equally among her 8 grandchildren. On the way home, one grandchild ate 3 of their lollipops. How many lollipops does that specific grandchild have left? 8 5 11 56 Correct Answer: 5
- Choices: Unavailable
- Correct answer: Unavailable
- Reason: At least two choices are required.

#### grade 4/boss question.docx — question 1

- Stable fingerprint: `096ca1457e44243929f4495a49d81be3891a83a5b1687f0fc0f6acb0f63de8d4`
- Grade / difficulty / location: Grade 4 | Unknown | Unknown
- Original difficulty: Unknown
- Proposed topic: None
- Confirmed topic: None
- Question: Solve the following expression and round off your final answer to the nearest hundredths: $$(12.45 \times 0.5) + (18.932 \div 4)$$ 10.95 10.96 10.96 11.00 Correct Answer: 10.96
- Choices: Unavailable
- Correct answer: Unavailable
- Reason: At least two choices are required.

#### grade 4/Easy/easy.docx — question 1

- Stable fingerprint: `52c5237835b631c4eb5a0e7d9355324d6fc0ceda83c9132319b4bf2d5d1fb4c0`
- Grade / difficulty / location: Grade 4 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: None
- Confirmed topic: None
- Question: Which of these numbers is a factor of 56?
- Choices: 3 | 4 (Correct: $56 \div 4 = 14$) | 5 | 6 | 5 | 10 | 15 | 20 (Correct: All these numbers divide into 20 perfectly.) | 3 | 4 | 5 (Correct: 24 cannot be divided by 5 without a remainder.) | 6 | 10 | 15 | 20 (Correct: $4 \times 5 = 20$) | 25 | 2 | 3 (Correct: These are all results of $3$ multiplied by $2, 3, 4, 5,$ and $6$.) | 4 | 5
- Correct answer: Unavailable
- Reason: Missing correct answer.

#### grade 5/boss question.docx — question 1

- Stable fingerprint: `59627c29dd0d4a910022dc071c68094284dcb5bd78a9f721a66e68423a3a9b75`
- Grade / difficulty / location: Grade 5 | Unknown | Unknown
- Original difficulty: Unknown
- Proposed topic: None
- Confirmed topic: None
- Question: number theory What is the Greatest Common Factor (GCF) of 48, 72, and 120? 12 24 36 48 Correct Answer: 24
- Choices: Unavailable
- Correct answer: Unavailable
- Reason: At least two choices are required.

#### grade 5/Difficult/difficult.docx — question 1

- Stable fingerprint: `ce91cbb673e206393a13c810bc67ba7c3a62f18a42f92800d3a881b4f18009cb`
- Grade / difficulty / location: Grade 5 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: Time Conversion, Number Theory Word Problems Order of Operations 1. Convert 85 minutes into hours and minutes.
- Choices: 1 hour 15 minutes | 1 hour 20 minutes | 1 hour 25 minutes (Correct: 85 - 60 = 25) | 2 hours 5 minutes | 20 | 21 | 23 (Correct: 23 has no factors other than 1 and itself.) | 25 | 250kg | 300kg (Correct: 15  X  20 = 300) | 350kg | 400kg | 10 | 12 (Correct: 1 \times 5 - 2 + 9 \rightarrow 5 - 2 + 9 = 12) | 14 | 15 | 32 | 36 | 38 (Correct: $6 + 32 = 38$) | 44
- Correct answer: Unavailable
- Reason: Missing correct answer.

#### grade 5/Easy/easy.docx — question 1

- Stable fingerprint: `d2423e18689c120a79ce2c042d4785907ccef62c79abee1c813ce75b4b1ed213`
- Grade / difficulty / location: Grade 5 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: None
- Confirmed topic: None
- Question: Which of the following numbers is a perfect square?
- Choices: 50 | 64 (Answer: $8 \times 8 = 64$) | 70 | 80 | 4,600 | 4,650 | 4,700 (Answer: The tens digit 7 is greater than 5, so round up.) | 4,800 | Ten thousand | Hundred thousand (Answer: The 5 is in the 6th position from the right.) | Millions | Ten millions | 0.45 | 0.5 | 0.04 (Answer: 4 hundredths is smaller than 40 or 50 hundredths.) | 0.405 | 36 (Answer: The pattern adds 6 each time.) | 35 | 34 | 33
- Correct answer: Unavailable
- Reason: Missing correct answer.

#### grade 5/Normal/average.docx — question 1

- Stable fingerprint: `d2423e18689c120a79ce2c042d4785907ccef62c79abee1c813ce75b4b1ed213`
- Grade / difficulty / location: Grade 5 | Medium | City of Knowledge
- Original difficulty: Normal
- Proposed topic: None
- Confirmed topic: None
- Question: Which of the following numbers is a perfect square?
- Choices: 50 | 64 (Answer: $8 \times 8 = 64$) | 70 | 80 | 4,600 | 4,650 | 4,700 (Answer: The tens digit 7 is greater than 5, so round up.) | 4,800 | Ten thousand | Hundred thousand (Answer: The 5 is in the 6th position from the right.) | Millions | Ten millions | 0.45 | 0.5 | 0.04 (Answer: 4 hundredths is smaller than 40 or 50 hundredths.) | 0.405 | 36 (Answer: The pattern adds 6 each time.) | 35 | 34 | 33
- Correct answer: Unavailable
- Reason: Missing correct answer.

#### grade 6/boss question.docx — question 1

- Stable fingerprint: `30da669703482dd2aa32cea566b250ad1719033c7bd06c1bbbe3b7942e2e192b`
- Grade / difficulty / location: Grade 6 | Unknown | Unknown
- Original difficulty: Unknown
- Proposed topic: None
- Confirmed topic: None
- Question: A rectangular tank measuring 60cm by 40cm by 50cm is filled with water to a height of 30cm. How much more water (in liters) is needed to fill the tank completely? 24 Liters 48 Liters 72 Liters 120 Liters Correct Answer: 48 Liters
- Choices: Unavailable
- Correct answer: Unavailable
- Reason: At least two choices are required.

#### grade 6/Difficult/difficult.docx — question 1

- Stable fingerprint: `7c052ab9a0d83059ae0898785e66b51f263269b8ad2356b9e94b8a9e4df4e771`
- Grade / difficulty / location: Grade 6 | Hard | Pinehill Village
- Original difficulty: Difficult
- Proposed topic: None
- Confirmed topic: None
- Question: What is the value of $|-15| + (-7) \times 2$? 1 $-1$ 29 $-29$ Correct Answer: 1 2. Which integer is greater than $-5$ but less than $-2$? $-6$ $-4$ $-2$ $-1$ Correct Answer: -4 3. If a movie starts at 7:15 PM and lasts for 2 hours and 20 minutes, what time does it end? 9:15 PM 9:25 PM 9:35 PM 10:05 PM Correct Answer: 9:35 PM 4. Evaluate the expression: $-15 - (-8) + 10$ $-13$ $-3$ 3 17 Correct Answer: 3 5. An isosceles triangle has a base of 12 cm and one of its equal legs is 15 cm. What is its perimeter? 27 cm 39 cm 42 cm 45 cm Correct Answer: 42 cm
- Choices: Unavailable
- Correct answer: Unavailable
- Reason: At least two choices are required.

#### grade 6/Easy/easy.docx — question 4

- Stable fingerprint: `6a49f8c5c74c4d40224ba6c5961c8d7ceff98d62b8a0fd2606dd9fb7add3a32e`
- Grade / difficulty / location: Grade 6 | Easy | Oakleaf Village
- Original difficulty: Easy
- Proposed topic: None
- Confirmed topic: None
- Question: How many degrees are in a right angle?
- Choices: 45 | 90 | 180 | 360
- Correct answer: Unavailable
- Reason: Missing correct answer.

## Source files without parseable question records

| Source | Grade | Difficulty | Reason |
| --- | --- | --- | --- |
| Grade1/difficult.json | Grade 1 | Hard | No question records were found in this source. |
| Grade1/normal.json | Grade 1 | Medium | No question records were found in this source. |
