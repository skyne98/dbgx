#include <vector>
#include <map>
#include <string>
#include <memory>

struct Node {
    int id;
    std::string label;
    std::vector<int> children;
};

int main() {
    std::vector<int> nums = {10, 20, 30, 40, 50};
    std::map<std::string, int> scores = {{"alice", 95}, {"bob", 87}, {"carol", 91}};
    std::unique_ptr<Node> root = std::make_unique<Node>(Node{1, "root", {2, 3, 4}});
    std::vector<std::vector<int>> nested = {{1, 2}, {3, 4, 5}, {6}};

    int sum = 0;                       // line 16
    for (int v : nums) sum += v;

    return sum % 256;                  // line 19
}
