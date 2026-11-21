# Testing - Open /backend on terminal: python -m tests.test_retrieval_eval_statistics
import unittest

from evals.retrieval_eval import (
    bootstrap_interval,
    mcnemar_exact,
    paired_comparisons,
    paired_permutation_test,
    wilson_interval,
)


def configuration(name: str, hits: list[int]) -> dict:
    rows = [
        {"answerable": True, "hit@1": hit, "hit@3": hit, "hit@5": hit, "recall@5": hit, "rr": hit}
        for hit in hits
    ]
    rows.append({"answerable": False})
    return {"configuration": name, "rows": rows}


class McNemarTests(unittest.TestCase):
    def test_counts_only_discordant_questions(self):
        p_value, only_a, only_b = mcnemar_exact([1, 1, 0, 0, 0, 1], [1, 0, 1, 1, 1, 1])

        self.assertEqual((only_a, only_b), (1, 3))
        # Binomial(4, 1/2): 2 * P(X <= 1) = 2 * 5/16.
        self.assertAlmostEqual(p_value, 0.625)

    def test_one_sided_disagreement(self):
        p_value, _, _ = mcnemar_exact([0] * 5, [1] * 5)

        self.assertAlmostEqual(p_value, 2 / 32)

    def test_identical_results(self):
        self.assertEqual(mcnemar_exact([1, 0, 1], [1, 0, 1]), (1.0, 0, 0))


class PermutationTests(unittest.TestCase):
    def test_no_difference_gives_p_one(self):
        self.assertEqual(paired_permutation_test([0.5, 1.0], [0.5, 1.0]), 1.0)

    def test_consistent_difference_is_significant(self):
        self.assertLess(paired_permutation_test([1.0] * 20, [0.0] * 20), 0.001)

    def test_balanced_differences_are_not_significant(self):
        self.assertGreater(paired_permutation_test([1, 0] * 10, [0, 1] * 10), 0.5)


class BootstrapTests(unittest.TestCase):
    def test_interval_contains_the_mean_and_is_reproducible(self):
        values = [1] * 30 + [0] * 9

        low, high = bootstrap_interval(values)

        self.assertLess(low, 30 / 39)
        self.assertGreater(high, 30 / 39)
        self.assertEqual(bootstrap_interval(values), [low, high])

    def test_constant_values_have_no_width(self):
        self.assertEqual(bootstrap_interval([1, 1, 1]), [1.0, 1.0])


class WilsonTests(unittest.TestCase):
    def test_all_hits_still_have_a_lower_bound_below_one(self):
        low, high = wilson_interval([1] * 39)

        self.assertAlmostEqual(low, 0.910, places=3)
        self.assertEqual(high, 1.0)

    def test_matches_reference_value(self):
        # 33 de 39: proporção 0,846. Limites obtidos resolvendo numericamente
        # |p̂ - p| = z * sqrt(p(1 - p)/n): [0,7027; 0,9275].
        low, high = wilson_interval([1] * 33 + [0] * 6)

        self.assertAlmostEqual(low, 0.7027, places=4)
        self.assertAlmostEqual(high, 0.9275, places=4)


class PairedComparisonsTests(unittest.TestCase):
    def test_compares_only_configurations_that_differ_in_one_factor(self):
        results = [
            configuration("structured/dense", [1, 1, 0, 1]),
            configuration("structured/hybrid", [1, 1, 1, 1]),
            configuration("baseline/dense", [1, 0, 0, 1]),
        ]

        comparisons = paired_comparisons(results)

        self.assertEqual(
            [(item["a"], item["b"]) for item in comparisons],
            [("structured/hybrid", "structured/dense"), ("structured/dense", "baseline/dense")],
        )
        hit = comparisons[0]["metrics"]["hit@1"]
        self.assertAlmostEqual(hit["difference"], 0.25)
        self.assertEqual((hit["only_a"], hit["only_b"]), (1, 0))
        self.assertEqual(comparisons[0]["metrics"]["mrr"]["test"], "permutação pareada")


if __name__ == "__main__":
    unittest.main()
