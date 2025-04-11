# Nx + PHPUnit Example

This is an example workspace of a PHP project using PHPUnit to test code. The plugin at `packages/phpunit` infers `test` and `test-ci` (Atomizer) targets from `phpunit.xml` files.

You can run the tests locally:

```
nx test example/test
```

In CI, the duration of running tests is around 20 minutes. With distribution (i.e. Nx Agents) that time goes from 20 minutes to:
- 9 minutes with 3 agents
- 7 minutes with 5 agents
- 4.5 minutes with 8 agents

See: https://github.com/jaysoo/php-example/actions

With distribution via 8 agents, we reduced the CI duration by over 75%.

Note: This is just a PoC, and things like generating and merging coverage reports is not handled. The tests are also artifically slow using `sleep` and may not be reflective of real-world tests.
