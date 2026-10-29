#' Standard error of the mean
#'
#' @param x a numeric vector
#' @param na.rm logical; should missing values be dropped?
#' @return the standard error of the mean of `x`
#' @export
sem <- function(x, na.rm = TRUE) {
  if (na.rm) x <- x[!is.na(x)]
  if (length(x) < 2) return(NA_real_)
  stats::sd(x) / sqrt(length(x))
}

#' Normal-approximation confidence interval for a mean
#'
#' @param x a numeric vector
#' @param level the confidence level, between 0 and 1
#' @return a named numeric vector with `lower` and `upper`
#' @export
mean_ci <- function(x, level = 0.95) {
  stopifnot(level > 0, level < 1)
  z <- stats::qnorm(1 - (1 - level) / 2)
  centre <- mean(x, na.rm = TRUE)
  half <- z * sem(x)
  c(lower = centre - half, upper = centre + half)
}

#' Rescale a vector to the unit interval
#'
#' Constant vectors are returned as all zeros rather than as `NaN`.
#'
#' @param x a numeric vector
#' @return `x` rescaled to `[0, 1]`
#' @export
rescale01 <- function(x) {
  span <- range(x, na.rm = TRUE)
  if (isTRUE(all.equal(span[1], span[2]))) return(rep(0, length(x)))
  (x - span[1]) / (span[2] - span[1])
}
