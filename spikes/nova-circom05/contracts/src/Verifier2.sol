// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

library Pairing2 {
    uint256 constant PRIME_Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    struct G1Point {
        uint256 X;
        uint256 Y;
    }

    // Encoding of field elements is: X[0] * z + X[1]
    struct G2Point {
        uint256[2] X;
        uint256[2] Y;
    }

    /*
     * @return The negation of p, i.e. p.plus(p.negate()) should be zero
     */
    function negate(G1Point memory p) internal pure returns (G1Point memory) {
        // The prime q in the base field F_q for G1
        if (p.X == 0 && p.Y == 0) {
            return G1Point(0, 0);
        } else {
            return G1Point(p.X, PRIME_Q - (p.Y % PRIME_Q));
        }
    }

    /*
     * @return r the sum of two points of G1
     */
    function plus(
        G1Point memory p1,
        G1Point memory p2
    ) internal view returns (G1Point memory r) {
        uint256[4] memory input = [
            p1.X, p1.Y,
            p2.X, p2.Y
        ];
        bool success;

        // solium-disable-next-line security/no-inline-assembly
        assembly {
            success := staticcall(sub(gas(), 2000), 6, input, 0xc0, r, 0x60)
            // Use "invalid" to make gas estimation work
            switch success case 0 { invalid() }
        }

        require(success, "pairing-add-failed");
    }

    /*
     * @return r the product of a point on G1 and a scalar, i.e.
     *         p == p.scalarMul(1) and p.plus(p) == p.scalarMul(2) for all
     *         points p.
     */
    function scalarMul(G1Point memory p, uint256 s) internal view returns (G1Point memory r) {
        uint256[3] memory input = [p.X, p.Y, s];
        bool success;

        // solium-disable-next-line security/no-inline-assembly
        assembly {
            success := staticcall(sub(gas(), 2000), 7, input, 0x80, r, 0x60)
            // Use "invalid" to make gas estimation work
            switch success case 0 { invalid() }
        }

        require(success, "pairing-mul-failed");
    }

    /* @return The result of computing the pairing check
     *         e(p1[0], p2[0]) *  .... * e(p1[n], p2[n]) == 1
     *         For example,
     *         pairing([P1(), P1().negate()], [P2(), P2()]) should return true.
     */
    function pairing(
        G1Point memory a1,
        G2Point memory a2,
        G1Point memory b1,
        G2Point memory b2,
        G1Point memory c1,
        G2Point memory c2,
        G1Point memory d1,
        G2Point memory d2
    ) internal view returns (bool) {
        uint256[24] memory input = [
            a1.X, a1.Y, a2.X[0], a2.X[1], a2.Y[0], a2.Y[1],
            b1.X, b1.Y, b2.X[0], b2.X[1], b2.Y[0], b2.Y[1],
            c1.X, c1.Y, c2.X[0], c2.X[1], c2.Y[0], c2.Y[1],
            d1.X, d1.Y, d2.X[0], d2.X[1], d2.Y[0], d2.Y[1]
        ];
        uint256[1] memory out;
        bool success;

        // solium-disable-next-line security/no-inline-assembly
        assembly {
            success := staticcall(sub(gas(), 2000), 8, input, mul(24, 0x20), out, 0x20)
            // Use "invalid" to make gas estimation work
            switch success case 0 { invalid() }
        }

        require(success, "pairing-opcode-failed");
        return out[0] != 0;
    }
}

contract Verifier2 {
    uint256 constant SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant PRIME_Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    using Pairing2 for *;

    struct VerifyingKey {
        Pairing2.G1Point alfa1;
        Pairing2.G2Point beta2;
        Pairing2.G2Point gamma2;
        Pairing2.G2Point delta2;
        Pairing2.G1Point[8] IC;
    }

    function verifyingKey() internal pure returns (VerifyingKey memory vk) {
          vk.alfa1 = Pairing2.G1Point(7072463470372644395001296751808006283705200758443645231373742360276065829692, 16705570726390187344926247663758232598613612864007554492843992673612591896983);
          vk.beta2 = Pairing2.G2Point([1027163064706174615137085567181092327254549335432801566792677553134659469281, 13142882322335817441329511362692131257824721456604152183347934741290466681153], [683155676318457066028623216287489452104949555858455512982810520946492820477, 2567083673727471491254865324038361593087791328207377841319296454405417274276]);
          vk.gamma2 = Pairing2.G2Point([11559732032986387107991004021392285783925812861821192530917403151452391805634, 10857046999023057135944570762232829481370756359578518086990519993285655852781], [4082367875863433681332203403145435568316851327593401208105741076214120093531, 8495653923123431417604973247489272438418190587263600148770280649306958101930]);
          vk.delta2 = Pairing2.G2Point([18202868522121804784114797219615045993450597958271194137574758241299353293452, 17150413843014547219772273345942866117451779774489111264078918254687253638778], [3076009963293877088445754062276841944004322105889333970177167601014982666702, 11619276405580770889675610582912090292879805929532536826768638807236620362984]);
          
          vk.IC[0] = Pairing2.G1Point(509283059696682561882785054961474569124393048803367630425592025213349521890, 9238891332786145094561791763126824119715006251674864160504371304529554452854);
          vk.IC[1] = Pairing2.G1Point(17160085438870847370308394887159943605154554114860871562485583506566376909589, 6679585004201684054543991364178338794801773945610809408433721757889415209876);
          vk.IC[2] = Pairing2.G1Point(10233117280494721369885045860083294650175329739900877488385641436983908076806, 18266983426061682897971442074517656576883351357993192846263541168750787092018);
          vk.IC[3] = Pairing2.G1Point(2216707025414023657811990136522338989752114956560647211024890333854100092387, 17649771532079970424689420915991736074014214235826475035604418622234371319812);
          vk.IC[4] = Pairing2.G1Point(13554130820839797026470514992500097000879532353691323611352789320880941313972, 17676030625268438819711376359502262494974592047478549781940202504238512219361);
          vk.IC[5] = Pairing2.G1Point(10748041017537607606981244991882313913376374752854248981340250044854851282699, 21359637859075529300093022213029911478171228806524486942426745622701878392532);
          vk.IC[6] = Pairing2.G1Point(20327149116527789159396826090043880268628708192832057946730168171423011281652, 19449161214994198973599375630231913619791935107955020700783730023279554275757);
          vk.IC[7] = Pairing2.G1Point(6229013450004226276524255120616119033230310987258271722137192754485489674600, 16926231976151165015292245236329956409512638416018887624153265806855912149348);
    }

    /*
     * @returns Whether the proof is valid given the hardcoded verifying key
     *          above and the public inputs
     */
    function verifyProof(
        bytes memory proof,
        uint256[7] memory input
    ) public view returns (bool) {
        uint256[8] memory p = abi.decode(proof, (uint256[8]));
        for (uint8 i = 0; i < p.length; i++) {
            // Make sure that each element in the proof is less than the prime q
            require(p[i] < PRIME_Q, "verifier-proof-element-gte-prime-q");
        }
        Pairing2.G1Point memory proofA = Pairing2.G1Point(p[0], p[1]);
        Pairing2.G2Point memory proofB = Pairing2.G2Point([p[2], p[3]], [p[4], p[5]]);
        Pairing2.G1Point memory proofC = Pairing2.G1Point(p[6], p[7]);

        VerifyingKey memory vk = verifyingKey();
        // Compute the linear combination vkX
        Pairing2.G1Point memory vkX = vk.IC[0];
        for (uint256 i = 0; i < input.length; i++) {
            // Make sure that every input is less than the snark scalar field
            require(input[i] < SNARK_SCALAR_FIELD, "verifier-input-gte-snark-scalar-field");
            vkX = Pairing2.plus(vkX, Pairing2.scalarMul(vk.IC[i + 1], input[i]));
        }

        return Pairing2.pairing(
            Pairing2.negate(proofA),
            proofB,
            vk.alfa1,
            vk.beta2,
            vkX,
            vk.gamma2,
            proofC,
            vk.delta2
        );
    }
}

