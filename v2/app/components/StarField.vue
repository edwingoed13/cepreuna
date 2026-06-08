<template>
  <div
    aria-hidden="true"
    class="pointer-events-none absolute inset-0 hidden overflow-hidden dark:block"
  >
    <div class="inscripciones-radial-glow" />
    <div class="inscripciones-star-field" />
  </div>
</template>

<style scoped>
.inscripciones-radial-glow {
  position: absolute;
  inset-inline: 0;
  top: 4rem;
  height: 42rem;
  opacity: 1;
  background:
    linear-gradient(
      180deg,
      rgb(21 48 87 / 0.92) 0%,
      rgb(15 35 66 / 0.72) 22%,
      rgb(7 14 31 / 0.42) 52%,
      transparent 82%
    ),
    radial-gradient(
      ellipse 80% 48% at 50% 8%,
      rgb(59 130 246 / 0.22) 0%,
      rgb(37 99 235 / 0.14) 36%,
      transparent 72%
    );
}

.inscripciones-star-field {
  position: absolute;
  inset: -10rem 0 0;
  overflow: hidden;
}

.inscripciones-star-field::before,
.inscripciones-star-field::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  border-radius: 9999px;
  background: rgb(96 165 250 / 0.85);
  animation:
    inscripciones-star-drift 48s linear infinite,
    inscripciones-star-twinkle 3.4s ease-in-out infinite;
  will-change: transform, opacity;
}

.inscripciones-star-field::before {
  width: 2.2px;
  height: 2.2px;
  box-shadow:
    2vw 28vh rgb(96 165 250 / 0.7),
    4vw 44vh rgb(147 197 253 / 0.48),
    6vw 51vh rgb(147 197 253 / 0.55),
    11vw 19vh rgb(96 165 250 / 0.5),
    14vw 33vh rgb(255 255 255 / 0.34),
    16vw 76vh rgb(255 255 255 / 0.35),
    21vw 38vh rgb(96 165 250 / 0.62),
    23vw 55vh rgb(96 165 250 / 0.48),
    26vw 64vh rgb(147 197 253 / 0.5),
    31vw 24vh rgb(96 165 250 / 0.68),
    34vw 41vh rgb(147 197 253 / 0.44),
    36vw 83vh rgb(255 255 255 / 0.32),
    42vw 47vh rgb(96 165 250 / 0.58),
    45vw 29vh rgb(255 255 255 / 0.32),
    48vw 71vh rgb(147 197 253 / 0.46),
    53vw 31vh rgb(96 165 250 / 0.64),
    56vw 52vh rgb(147 197 253 / 0.46),
    59vw 88vh rgb(255 255 255 / 0.3),
    64vw 42vh rgb(96 165 250 / 0.56),
    66vw 28vh rgb(255 255 255 / 0.3),
    69vw 67vh rgb(147 197 253 / 0.5),
    74vw 22vh rgb(96 165 250 / 0.7),
    77vw 45vh rgb(96 165 250 / 0.5),
    79vw 79vh rgb(255 255 255 / 0.34),
    84vw 36vh rgb(96 165 250 / 0.58),
    87vw 84vh rgb(147 197 253 / 0.42),
    89vw 57vh rgb(147 197 253 / 0.52),
    94vw 18vh rgb(96 165 250 / 0.62),
    96vw 39vh rgb(255 255 255 / 0.32),
    98vw 72vh rgb(255 255 255 / 0.3),
    4vw 92vh rgb(96 165 250 / 0.55),
    13vw 108vh rgb(147 197 253 / 0.42),
    24vw 98vh rgb(96 165 250 / 0.52),
    35vw 117vh rgb(255 255 255 / 0.28),
    46vw 103vh rgb(96 165 250 / 0.58),
    57vw 126vh rgb(147 197 253 / 0.44),
    68vw 111vh rgb(96 165 250 / 0.54),
    80vw 121vh rgb(255 255 255 / 0.3),
    91vw 101vh rgb(96 165 250 / 0.57);
}

.inscripciones-star-field::after {
  width: 3px;
  height: 3px;
  background: rgb(147 197 253 / 0.65);
  box-shadow:
    8vw 35vh rgb(147 197 253 / 0.44),
    12vw 63vh rgb(96 165 250 / 0.36),
    18vw 58vh rgb(96 165 250 / 0.42),
    28vw 15vh rgb(147 197 253 / 0.48),
    32vw 77vh rgb(255 255 255 / 0.28),
    39vw 69vh rgb(96 165 250 / 0.4),
    51vw 23vh rgb(147 197 253 / 0.46),
    58vw 61vh rgb(255 255 255 / 0.28),
    62vw 73vh rgb(96 165 250 / 0.42),
    73vw 49vh rgb(147 197 253 / 0.5),
    81vw 15vh rgb(96 165 250 / 0.38),
    86vw 26vh rgb(96 165 250 / 0.43),
    96vw 62vh rgb(147 197 253 / 0.45),
    14vw 91vh rgb(96 165 250 / 0.36),
    33vw 105vh rgb(147 197 253 / 0.4),
    55vw 96vh rgb(96 165 250 / 0.38),
    77vw 116vh rgb(147 197 253 / 0.42),
    93vw 108vh rgb(96 165 250 / 0.38);
  animation-duration: 72s, 4.8s;
  animation-delay: 0s, -1.6s;
}

@keyframes inscripciones-star-drift {
  from {
    transform: translate3d(0, 0, 0);
  }

  to {
    transform: translate3d(0, -12rem, 0);
  }
}

@keyframes inscripciones-star-twinkle {
  0%,
  100% {
    opacity: 0.45;
  }

  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .inscripciones-star-field::before,
  .inscripciones-star-field::after {
    animation: none;
  }
}
</style>
